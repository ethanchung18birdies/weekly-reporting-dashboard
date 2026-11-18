import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/backlog-history.js';
const page = rows => ({page:{number:1,totalElements:rows.length,totalPages:rows.length?1:0},_embedded:{conversations:rows}});
async function call(query) {
 let status,body;
 await handler({method:'GET',query},{setHeader(){},status(code){status=code;return this},json(value){body=value;}});
 return {status,body};
}
function api(t,changed) {
 t.mock.method(globalThis,'fetch',async input=>{
  const url=new URL(input);
  if(url.pathname.endsWith('/oauth2/token'))return Response.json({access_token:'test-only',expires_in:3600});
  assert.equal(url.pathname,'/v2/conversations');
  if(url.searchParams.get('status')==='active')return Response.json(page([{id:1,status:'active'},{id:2,status:'closed'}]));
  const since=Date.parse(url.searchParams.get('modifiedSince'));
  if(since>Date.now()-60_000)return Response.json(page(changed?[{id:1}]:[]));
  return Response.json(page([{id:1,number:1,status:'active',threads:1,createdAt:'2026-01-01T00:00:00Z',
   _embedded:{threads:[{id:2,type:'customer',state:'published',status:'active',createdAt:'2026-01-01T00:00:00Z',body:'private body not returned'}]},subject:'private subject'}]));
 });
}
test('history API returns aggregates only and verifies against actual active statuses',async t=>{
 api(t,false);
 const first=await call({});
 assert.equal(first.status,200);
 assert.equal(JSON.stringify(first.body).includes('private'),false);
 assert.equal(first.body.points.length,12);
 assert.equal(first.body.points[0].delta,0);
 const verified=await call({verify:'true',marker:first.body.marker});
 assert.equal(verified.status,200);
 assert.equal(verified.body.currentBacklog,1);
});
test('concurrent ticket changes prevent publishing a reconstructed history',async t=>{
 api(t,true);
 const first=await call({});
 const verified=await call({verify:'true',marker:first.body.marker});
 assert.equal(verified.status,409);
 assert.match(verified.body.error,/changed during history/);
});
