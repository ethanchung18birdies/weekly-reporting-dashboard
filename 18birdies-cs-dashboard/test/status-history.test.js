import assert from 'node:assert/strict';
import test from 'node:test';
import {conversationHistoryEntries,summarizeHistoryEntries,buildHistorySnapshot,validateHistoryPage} from '../lib/backlog-history.js';
const at=day=>`2026-11-${String(day).padStart(2,'0')}T08:00:00Z`;
const event=(id,day,status,extra={})=>({id,createdAt:at(day),status,type:'lineitem',...extra});
const ticket=(events,status='active',extra={})=>({id:1,createdAt:at(1),status,threads:0,_embedded:{threads:events},...extra});
const ranges=(row,days)=>summarizeHistoryEntries(conversationHistoryEntries(row,days.map(at)),days.map(at)).map(p=>[p.low,p.high]);
test('reopenings, Pending and repeated closes change only the active stock',()=>{
 const c=ticket([event(1,1,'active'),event(2,3,'closed'),event(3,4,'closed'),event(4,5,'active'),event(5,7,'pending'),event(6,9,'active')]);
 assert.deepEqual(ranges(c,[2,4,5,6,8,10]),[[0,0],[-1,-1],[-1,-1],[0,0],[-1,-1],[0,0]]);
});
test('creation at a boundary belongs to the new week; future-created parent cannot affect old history',()=>{
 assert.deepEqual(ranges(ticket([event(1,4,'active')],'active',{createdAt:at(4)}),[2,4,5]),[[-1,-1],[-1,-1],[0,0]]);
});
test('drafts do not change status; same-second close action beats accompanying reply',()=>{
 assert.deepEqual(ranges(ticket([event(1,1,'active'),event(2,3,'closed',{type:'message',state:'draft'})]),[4]),[[0,0]]);
 assert.deepEqual(ranges(ticket([event(1,1,'active'),event(2,3,'active',{type:'message',state:'published'}),event(3,3,'closed')],'closed',{threads:1}),[4]),[[0,0]]);
});
test('a single unknown ticket widens an interval by one instead of blanking all totals',()=>{
 assert.deepEqual(ranges(ticket([]),[2]),[[-1,0]]);
 assert.deepEqual(ranges(ticket([event(1,1,'active')],'active',{threads:1}),[2]),[[-1,0]]);
});
test('merged source statuses are separated from parent; source ceases to exist at merge',()=>{
 const merge={type:'merged',associatedEntities:{originalConversation:2}};
 const c=ticket([event(1,1,'active'),event(2,2,'closed'),event(3,1,'active',{action:merge}),event(4,5,undefined,{action:merge})],'closed');
 // Parent closed; source active until merge. Repeated source events count once.
 assert.deepEqual(ranges(c,[3,6]),[[1,1],[0,0]]);
});
test('unknown source creation is 0–1 before retained history, never a global gap',()=>{
 const merge={type:'merged',associatedEntities:{originalConversation:{id:2}}};
 const c=ticket([event(1,4,'active'),event(2,4,'active',{type:'customer',state:'published',action:merge}),event(3,5,undefined,{action:merge})],'active',{createdAt:at(4),threads:1});
 assert.deepEqual(ranges(c,[2,6]),[[-1,0],[0,0]]);
});
test('unknown source IDs count merge actions once, not each imported message',()=>{
 const c=ticket([event(1,1,'active'),event(2,4,undefined,{action:{type:'merged'}}),event(3,2,'active',{type:'message',state:'published',action:{type:'merged'}})],'active',{threads:1});
 assert.deepEqual(ranges(c,[3,5]),[[0,1],[0,0]]);
});
test('deduplication prioritizes a canonical source history over repeated imported copies',()=>{
 const b=[at(2)];const entries=conversationHistoryEntries(ticket([event(1,1,'active')]),b);
 assert.equal(summarizeHistoryEntries([...entries,...entries],b)[0].low,0);
 const p=summarizeHistoryEntries([{key:'x',priority:1,points:[{low:0,high:1}]},{key:'x',priority:2,points:[{low:1,high:1}]}],b)[0];
 assert.deepEqual([p.low,p.high],[1,1]);
});
test('negative incompatible ranges stay unavailable; a range crossing zero intersects physical counts',()=>{
 const weeks=[{startStr:'a'},{startStr:'b'}];
 const s=buildHistorySnapshot(weeks,[{low:-20,high:-10},{low:-2,high:3}],1);
 assert.equal(s.weeks[0].startRange,null);
 assert.deepEqual(s.weeks[1].startRange,{low:0,high:4});
});
test('pagination rejects missing pages and duplicate record numbers',()=>{
 const d={page:{number:1,totalElements:2,totalPages:1},_embedded:{conversations:[{number:2},{number:1}]}};
 assert.equal(validateHistoryPage(d,1).length,2);assert.throws(()=>validateHistoryPage(d,2));
 d._embedded.conversations[1].number=2;assert.throws(()=>validateHistoryPage(d,1));
});
