import { readFileSync } from 'node:fs';
import { hsGetWithRetry, getWeekRanges, getCurrentBacklog } from '../lib/helpscout.js';
import { reportBounds } from '../lib/reporting-time.js';
import { conversationHistoryEntries, historyKey, validateHistoryPage } from '../lib/backlog-history.js';

// A reviewed aggregate snapshot makes first paint fast. New weekly boundaries
// are rebuilt in bounded batches; only anonymous status contributions leave here.
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try {
    if(req.query.seed==='true')return res.status(200).json(JSON.parse(readFileSync(new URL('../lib/backlog-history-snapshot.json',import.meta.url),'utf8')));
    const page=Number(req.query.page||1);
    if(!Number.isInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
    const weeks=getWeekRanges(12),boundaries=weeks.map(w=>reportBounds(w.startStr,w.startStr).start);
    const previous=req.query.marker?JSON.parse(req.query.marker):null;
    const startedAt=previous?.[2]||new Date(Date.now()-1000).toISOString().replace(/\.\d{3}Z$/,'Z');
    if(previous&&(previous[0]!==boundaries[0]||!Number.isInteger(previous[1])||!Number.isFinite(Date.parse(startedAt))
       ||Date.parse(startedAt)>Date.now()))return res.status(409).json({error:'History scan expired'});
    const params={mailbox:process.env.HELPSCOUT_MAILBOX_ID,status:'all',modifiedSince:boundaries[0],query:`(createdAt:[* TO ${startedAt}])`};
    if(req.query.verify==='true') {
      if(!previous)return res.status(400).json({error:'Missing scan marker'});
      const expectedCount=Number(req.query.count);
      if(!Number.isInteger(expectedCount)||expectedCount<0)return res.status(400).json({error:'Missing population count'});
      // Normal activity during a long scan adds a bounded uncertainty rather
      // than invalidating the entire chart. New active tickets are removed from
      // the historical anchor because they did not exist at any earlier boundary.
      const anchor=await getCurrentBacklog();
      const changed=new Map();let n=1,totalPages;
      do {
        const d=await hsGetWithRetry('/conversations',{mailbox:process.env.HELPSCOUT_MAILBOX_ID,status:'all',modifiedSince:startedAt,embed:'threads',page:n},2);
        totalPages=d?.page?.totalPages;
        if(!Number.isInteger(totalPages)||!Array.isArray(d?._embedded?.conversations)&&d?.page?.totalElements!==0)throw new Error('Change scan incomplete');
        for(const c of d._embedded?.conversations||[])changed.set(c.id,c);
        n++;
      }while(n<=totalPages);
      const population=await hsGetWithRetry('/conversations',{...params,page:1},2);
      if(anchor.total===null||!Number.isInteger(population?.page?.totalElements))throw new Error('Live anchor unavailable');
      const recent=[...changed.values()];
      const newActive=recent.filter(c=>Date.parse(c.createdAt)>Date.parse(startedAt)&&c.status==='active').length;
      const changedEntities=new Set(recent.flatMap(c=>conversationHistoryEntries(c,boundaries).map(e=>e.key)));
      return res.status(200).json({currentBacklog:anchor.total,adjustment:-newActive,
        uncertainty:changedEntities.size+Math.abs(population.page.totalElements-expectedCount),fetchedAt:new Date().toISOString()});
    }
    const fetchPage=async n=>{
      const data=await hsGetWithRetry('/conversations',{...params,embed:'threads',sortField:'number',sortOrder:'desc',page:n},2);
      return {data,rows:validateHistoryPage(data,n)};
    };
    const first=await fetchPage(page);
    const last=Math.min(Math.max(1,first.data.page.totalPages),page+7);
    const pages=[first];
    for(let n=page+1;n<=last;n+=3)pages.push(...await Promise.all(Array.from({length:Math.min(3,last-n+1)},(_,i)=>fetchPage(n+i))));
    const rows=pages.flatMap(p=>p.rows);
    const marker=req.query.marker||JSON.stringify([boundaries[0],first.data.page.totalElements,startedAt]);
    return res.status(200).json({weeks,boundaries,marker,page,totalPages:first.data.page.totalPages,
      records:rows.map(c=>historyKey(c.id)),entries:rows.flatMap(c=>conversationHistoryEntries(c,boundaries)),
      nextPage:last<first.data.page.totalPages?last+1:null});
  }catch(error){
    console.error('Backlog history unavailable:',error.message);
    return res.status(503).json({error:'History refresh unavailable; the last aggregate snapshot remains visible'});
  }
}
