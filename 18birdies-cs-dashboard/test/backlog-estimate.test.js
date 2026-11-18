import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { getWeekReport } from '../lib/helpscout.js';
import { reportBounds, pacificDate } from '../lib/reporting-time.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const functions = ['finalizeBacklogHistory', 'getCurrentBacklogAnchor', 'getWeeklyNetFlow', 'getEstimatedBacklogSeries', 'getAverageWeeklyNetFlow']
  .map(name => html.match(new RegExp(`function ${name}\\(.*?\\) \\{[\\s\\S]*?\\n    \\}`))[0]).join('\n');
function evaluate(data, expression) {
  const result = vm.runInNewContext(`${functions}; ${expression}`, { allData: data });
  return JSON.parse(JSON.stringify(result));
}
const week = (opened, totalClosed, endStr = '2026-11-15') => ({ opened, totalClosed, endStr });

test('chart uses status-history stock and never falls back to created/closed reports', () => {
  const data = { currentBacklog: 59, weeks: [
    {startStr:'2026-11-02',opened:644,totalClosed:484},
    {startStr:'2026-11-09',opened:696,totalClosed:668},
    {startStr:'2026-11-16',opened:317,totalClosed:429},
  ], backlogHistory: { weeks: [
    {startStr:'2026-11-02',backlog:null,netBurn:null},
    {startStr:'2026-11-09',backlog:150,netBurn:null},
    {startStr:'2026-11-16',backlog:59,netBurn:91},
  ] } };
  assert.deepEqual(evaluate(data,'getEstimatedBacklogSeries()'),[null,150,59]);
  assert.equal(evaluate(data,'getWeeklyNetFlow(allData.weeks[2])'),91);
  delete data.backlogHistory;
  assert.deepEqual(evaluate(data,'getEstimatedBacklogSeries()'),[null,null,59]);
  assert.equal(evaluate(data,'getWeeklyNetFlow(allData.weeks[2])'),null);
});
test('verified historical and current zero remain valid; missing live count is not zero', () => {
  const data={currentBacklog:0,weeks:[{startStr:'a'},{startStr:'b'}],backlogHistory:{weeks:[{startStr:'a',backlog:0}]}};
  assert.deepEqual(evaluate(data,'getEstimatedBacklogSeries()'),[0,0]);
  data.currentBacklog=null;
  assert.deepEqual(evaluate(data,'getEstimatedBacklogSeries()'),[0,null]);
});
test('average uses four complete verified status-history weeks, excluding partial week',()=>{
  const weeks=['2026-10-25','2026-11-01','2026-11-08','2026-11-15','2026-11-22'].map((endStr,i)=>({startStr:String(i),endStr}));
  const data={fetchedAt:'2026-11-18T17:00:00Z',weeks,backlogHistory:{weeks:weeks.map((w,i)=>({...w,netBurn:i===4?1000:20}))}};
  assert.equal(evaluate(data,'getAverageWeeklyNetFlow()'),20);
  data.backlogHistory.weeks[0].netBurn=null;
  assert.equal(evaluate(data,'getAverageWeeklyNetFlow()'),null);
});
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

test('finalized history reconciles to the anchor, preserves true zero, and gaps unknown boundaries',()=>{
 const data={weeks:[{startStr:'a'},{startStr:'b'},{startStr:'c'}],currentBacklog:1,
 points:[{delta:0,unknownTickets:0},{delta:-1,unknownTickets:0},{delta:0,unknownTickets:0}]};
 const run=()=>evaluate(data,'finalizeBacklogHistory(allData.weeks,allData.points,allData.currentBacklog)');
 assert.deepEqual(run().map(w=>[w.backlog,w.netBurn]),[[0,1],[1,-1],[1,0]]);
 data.points[1].delta=-2;
 assert.equal(run()[0].backlog,null);
 data.points[1].delta=-1;data.points[1].unknownTickets=1;
 assert.equal(run()[1].netBurn,null);
});

const historyLoader = html.match(/async function loadBacklogHistory\(data\) \{[\s\S]*?\n    \}/)[0];
async function runHistoryLoader(responses) {
 const data={currentBacklog:8,weeks:[{startStr:'a'},{startStr:'b'}]};
 let requests=0;
 const context={allData:data, URLSearchParams, renderAll(){},fetch:async()=>{
   const response=responses[requests++];
   assert.ok(response,'Unexpected extra history request');
   return {ok:!response.error,json:async()=>response};
 }};
 await vm.runInNewContext(`${functions};${historyLoader};loadBacklogHistory(allData)`,context);
 return {data,requests};
}
function batch(page,delta,unknown=0){
 return {page,marker:'stable',weeks:[{startStr:'a'},{startStr:'b'}],firstNumber:21-page,lastNumber:21-page,
 count:1,totalElements:2,nextPage:page===1?2:null,
 points:delta.map((value,i)=>({at:String(i),delta:value,unknownTickets:unknown,reasons:unknown?{merge_move_or_delete:unknown}:{}}))};
}
test('browser history loader accumulates every page and reanchors only after final verification',async()=>{
 const {data,requests}=await runHistoryLoader([batch(1,[2,0]),batch(2,[1,1]),{currentBacklog:10,fetchedAt:'2026-11-18T17:00:00Z'}]);
 assert.equal(requests,3);
 assert.equal(data.currentBacklog,10);
 assert.deepEqual(JSON.parse(JSON.stringify(data.backlogHistory.weeks)),[
  {startStr:'a',backlog:11,netBurn:2},{startStr:'b',backlog:10,netBurn:1}]);
});
test('browser does not publish partial sums or replace the live count when the scan changes',async()=>{
 const {data}=await runHistoryLoader([batch(1,[2,0]),batch(2,[1,1]),{error:true}]);
 assert.equal(data.currentBacklog,8);
 assert.equal(data.backlogHistory.status,'unavailable');
 assert.equal(data.backlogHistory.weeks.length,0);
});
test('known uncertainty at every boundary stops scanning without inventing a history',async()=>{
 const {data,requests}=await runHistoryLoader([batch(1,[2,0],1)]);
 assert.equal(requests,1);
 assert.equal(data.currentBacklog,8);
 assert.equal(data.backlogHistory.status,'unverified');
 assert.equal(data.backlogHistory.weeks.length,0);
});
