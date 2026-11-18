// Read-only Help Scout extraction. Run with node --env-file=.env.local scripts/build-backlog-history.mjs.
import{hsGetWithRetry,getCurrentBacklog,getWeekRanges}from'../lib/helpscout.js';
import fs from'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reportBounds} from '../lib/reporting-time.js';
import {conversationHistoryEntries,summarizeHistoryEntries,buildHistorySnapshot} from '../lib/backlog-history.js';
const weeks=getWeekRanges(12);
const boundaries=weeks.map(w=>reportBounds(w.startStr,w.startStr).start);
const folder=process.env.BACKLOG_CHECKPOINT_DIR || join(tmpdir(),`cs-backlog-range-${weeks[0].startStr}`);await fs.mkdir(folder,{recursive:true});
let config;try{config=JSON.parse(await fs.readFile(folder+'/config.json','utf8'));}catch{config={since:boundaries[0],asOf:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};await fs.writeFile(folder+'/config.json',JSON.stringify(config));}
if(config.since!==boundaries[0])throw new Error('Checkpoint belongs to a different reporting window');
const params={mailbox:process.env.HELPSCOUT_MAILBOX_ID,status:'all',modifiedSince:config.since,query:`(createdAt:[* TO ${config.asOf}])`,sortField:'number',sortOrder:'desc',embed:'threads'};
let slot=Date.now();const throttle=async()=>{const when=Math.max(slot,Date.now());slot=when+160;await new Promise(r=>setTimeout(r,when-Date.now()));};
async function page(n){let d;try{return JSON.parse(await fs.readFile(`${folder}/${n}.json`,'utf8'));}catch{} await throttle();for(let attempt=0;attempt<4;attempt++){try{d=await hsGetWithRetry('/conversations',{...params,page:n});break;}catch(error){if(attempt===3)throw error;await new Promise(r=>setTimeout(r,2000));}}const rows=d._embedded?.conversations?.map(c=>({id:c.id,number:c.number,createdAt:c.createdAt,status:c.status,threads:c.threads,mailboxId:c.mailboxId,_embedded:{threads:(c._embedded?.threads||[]).map(t=>({id:t.id,type:t.type,state:t.state,status:t.status,createdAt:t.createdAt,action:t.action?{type:t.action.type,associatedEntities:t.action.associatedEntities}:undefined}))}}));const compact={page:d.page,rows};await fs.writeFile(`${folder}/${n}.json`,JSON.stringify(compact));return compact;}
const first=await page(1);console.log(JSON.stringify({pages:first.page.totalPages,total:first.page.totalElements,asOf:config.asOf}));let next=2,done=1;await Promise.all(Array.from({length:4},async()=>{for(;;){const n=next++;if(n>first.page.totalPages)break;await page(n);done++;if(done%50===0)console.log('Fetched '+done+' pages');}}));
const rows=new Map();for(let n=1;n<=first.page.totalPages;n++)for(const c of(await page(n)).rows)rows.set(c.id,c);

if(rows.size!==first.page.totalElements)throw new Error('Incomplete extraction; retain checkpoints and retry');
// Refresh tickets modified while pages were fetched, so ordinary activity is
// reconciled before anchoring. Only the short final verification window widens
// the range; a busy mailbox no longer makes reconstruction impossible.
const refreshedAt=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
let n=1,changedPages;
do {
 const d=await hsGetWithRetry('/conversations',{mailbox:process.env.HELPSCOUT_MAILBOX_ID,status:'all',modifiedSince:config.asOf,embed:'threads',page:n});
 changedPages=d?.page?.totalPages;
 if(!Number.isInteger(changedPages))throw new Error('Incomplete refresh');
 for(const c of d._embedded?.conversations||[])rows.set(c.id,c);
 n++;
}while(n<=changedPages);
// Imported sources that disappeared during extraction must not retain a stale
// canonical contribution alongside the surviving conversation's source history.
const mergedSources=new Set();
for(const c of rows.values())for(const e of c._embedded?.threads||[]){
 const raw=e.action?.associatedEntities?.originalConversation;const id=typeof raw==='object'?raw?.id:raw;
 if(id&&String(id)!==String(c.id))mergedSources.add(Number(id));
}
for(const id of mergedSources)rows.delete(id);
const anchor=await getCurrentBacklog();
const changed=await hsGetWithRetry('/conversations',{mailbox:process.env.HELPSCOUT_MAILBOX_ID,status:'all',modifiedSince:refreshedAt,page:1});
if(anchor.total===null||!Number.isInteger(changed?.page?.totalElements))throw new Error('Anchor verification failed');
const population=await hsGetWithRetry('/conversations',{mailbox:process.env.HELPSCOUT_MAILBOX_ID,status:'all',modifiedSince:config.since,page:1});
const uncertainty=changed.page.totalElements+Math.abs(population.page.totalElements-rows.size);
const entries=[...rows.values()].flatMap(c=>conversationHistoryEntries(c,boundaries));
const points=summarizeHistoryEntries(entries,boundaries);
const snapshot=buildHistorySnapshot(weeks,points,anchor.total,0,uncertainty);
if(snapshot.weeks.some(w=>!w.startRange))throw new Error('History remains incompatible with active anchor; do not publish');
snapshot.audit={conversations:rows.size,anchor:anchor.total,uncertainDuringVerification:uncertainty};
await fs.writeFile(new URL('../lib/backlog-history-snapshot.json',import.meta.url),JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({complete:true,records:rows.size,anchor:anchor.total,uncertainty,ranges:snapshot.weeks.map(w=>({week:w.startStr,start:w.startRange,end:w.endRange}))}));
