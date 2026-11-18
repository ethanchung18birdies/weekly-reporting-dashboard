import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { getWeekReport } from '../lib/helpscout.js';
import { reportBounds, pacificDate } from '../lib/reporting-time.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const functions = ['getWeeklyHistory','getAverageWeeklyNetFlowRange','formatHistoryRange','finalizeBacklogHistory', 'getCurrentBacklogAnchor', 'getWeeklyNetFlow', 'getEstimatedBacklogSeries', 'getAverageWeeklyNetFlow']
  .map(name => html.match(new RegExp(`function ${name}\\(.*?\\) \\{[\\s\\S]*?\\n    \\}`))[0]).join('\n');
function evaluate(data, expression) {
  const result = vm.runInNewContext(`${functions}; ${expression}`, { allData: data });
  return JSON.parse(JSON.stringify(result));
}
const week = (opened, totalClosed, endStr = '2026-11-15') => ({ opened, totalClosed, endStr });

test('report boundaries use Pacific weeks including DST transitions', () => {
  assert.deepEqual(reportBounds('2026-10-26', '2026-11-01'),
    { start: '2026-10-26T07:00:00Z', end: '2026-11-02T07:59:59Z' });
  assert.deepEqual(reportBounds('2026-03-02', '2026-03-08'),
    { start: '2026-03-02T08:00:00Z', end: '2026-03-09T06:59:59Z' });
  assert.equal(pacificDate(new Date('2026-11-16T03:00:00Z')), '2026-11-15');
  assert.throws(() => reportBounds('2026-02-30', '2026-03-01'));
});
test('report counts preserve all closes separately from resolved and use the same Pacific bounds', async t => {
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/oauth2/token')) return Response.json({ access_token: 'test-only', expires_in: 3600 });
    assert.equal(url.pathname, '/v2/reports/email');
    assert.equal(url.searchParams.get('start'), '2026-11-09T08:00:00Z');
    assert.equal(url.searchParams.get('end'), '2026-11-16T07:59:59Z');
    return Response.json({ current: { volume: { emailConversations: 100 }, resolutions: { resolved: 80, closed: 120 } } });
  });
  const result = await getWeekReport('2026-11-09', '2026-11-15');
  assert.equal(result.opened, 100);
  assert.equal(result.closed, 80);
  assert.equal(result.totalClosed, 120);
});
test('failed or incomplete reports fail explicitly rather than fabricating zero activity', async t => {
  t.mock.method(console, 'error', () => {});
  for (const body of [new Response('Failed', { status: 400 }), Response.json({})]) {
    t.mock.method(globalThis, 'fetch', async () => body);
    await assert.rejects(getWeekReport('2026-11-09', '2026-11-15'), /metrics unavailable/);
  }
});


const snapshot={version:2,fetchedAt:'2026-11-18T17:00:00Z',weeks:[
 {startStr:'a',startRange:{low:140,high:150},endRange:{low:110,high:120}},
 {startStr:'b',startRange:{low:110,high:120},endRange:null}]};
test('historical range stays fixed while live anchor and current-week burn update',()=>{
 const data={weeks:[{startStr:'a'},{startStr:'b'}],snapshot,currentBacklog:30};
 const run=()=>evaluate(data,'finalizeBacklogHistory(allData.weeks,allData.snapshot,allData.currentBacklog)');
 assert.deepEqual(run().map(w=>[w.backlogLow,w.backlogHigh,w.netBurnLow,w.netBurnHigh]),[[110,120,20,40],[30,30,80,90]]);
 data.currentBacklog=20;
 assert.deepEqual(run().map(w=>[w.backlogLow,w.backlogHigh,w.netBurnLow,w.netBurnHigh]),[[110,120,20,40],[20,20,90,100]]);
});
test('chart uses estimate midpoints and does not fall back to created/closed totals',()=>{
 const data={currentBacklog:30,weeks:[{startStr:'a',opened:1000,totalClosed:0},{startStr:'b'}],backlogHistory:{weeks:[{startStr:'a',backlog:115}]}};
 assert.deepEqual(evaluate(data,'getEstimatedBacklogSeries()'),[115,30]);
 delete data.backlogHistory;assert.deepEqual(evaluate(data,'getEstimatedBacklogSeries()'),[null,30]);
});
test('completed-week burn average retains uncertainty and excludes the partial week',()=>{
 const weeks=['2026-10-25','2026-11-01','2026-11-08','2026-11-15','2026-11-22'].map((endStr,i)=>({startStr:String(i),endStr}));
 const data={fetchedAt:'2026-11-18T17:00:00Z',weeks,backlogHistory:{weeks:weeks.map((w,i)=>({...w,startLow:i===4?1000:100,startHigh:i===4?1000:120,backlogLow:40,backlogHigh:60}))}};
 assert.deepEqual(evaluate(data,'getAverageWeeklyNetFlowRange()'),{low:10,high:20});
 data.backlogHistory.weeks[0].startLow=null;assert.equal(evaluate(data,'getAverageWeeklyNetFlowRange()'),null);
});
const loader=html.match(/async function loadBacklogHistory\(data\) \{[\s\S]*?\n    \}/)[0];
async function runLoader(responses,cached=null){
 const data={currentBacklog:30,weeks:[{startStr:'a'},{startStr:'b'}]};let requests=0;
 const context={allData:data,URLSearchParams,renderAll(){},document:{querySelector(){return{};}},localStorage:{getItem(){return JSON.stringify(cached);},setItem(){}},fetch:async()=>{const r=responses[requests++];assert.ok(r,'Unexpected API call');return{ok:!r.error,json:async()=>r};}};
 await vm.runInNewContext(`${functions};${loader};loadBacklogHistory(allData)`,context);
 return{data,requests};
}
test('aggregate seed paints complete ranges immediately without a full mailbox rescan',async()=>{
 const{data,requests}=await runLoader([snapshot]);assert.equal(requests,1);
 assert.deepEqual(JSON.parse(JSON.stringify(data.backlogHistory.weeks.map(w=>w.backlog))),[115,30]);
});
test('temporary API failure preserves cached historical graph and live anchor',async()=>{
 const{data}=await runLoader([{error:true}],snapshot);
 assert.equal(data.currentBacklog,30);assert.equal(data.backlogHistory.status,'cached');assert.equal(data.backlogHistory.weeks[0].backlog,115);
});
test('new-week scan keeps uncertain contributions, deduplicates pages and produces finite ranges',async()=>{
 const batch={page:1,marker:'stable',weeks:[{startStr:'a'},{startStr:'b'}],boundaries:['a','b'],records:['one'],entries:[{key:'one',priority:2,points:[{low:100,high:110},{low:80,high:90}]}],totalPages:1,nextPage:null};
 const{data}=await runLoader([{version:2,weeks:[]},batch,{currentBacklog:30,adjustment:0,uncertainty:0,fetchedAt:'2026-11-18T17:00:00Z'}]);
 assert.equal(data.backlogHistory.weeks[0].backlog,115);assert.equal(data.backlogHistory.weeks[1].netBurnLow,80);
});
