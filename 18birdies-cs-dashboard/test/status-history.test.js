import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationBoundaryDeltas, summarizeHistoryPage, validateHistoryPage } from '../lib/backlog-history.js';
const at = day => `2026-11-${String(day).padStart(2,'0')}T08:00:00Z`;
const event = (id, day, status, extra = {}) => ({id, createdAt:at(day), status, type:'lineitem', ...extra});
const ticket = (events, status='active', extra={}) => ({id:1, createdAt:at(1), status, threads:0, _embedded:{threads:events}, ...extra});
const deltas = (row, days) => conversationBoundaryDeltas(row,days.map(at)).map(r=>r.delta);

test('reopens and Pending changes affect Active stock, repeated closes do not',()=>{
 const row=ticket([event(1,1,'active'),event(2,3,'closed'),event(3,4,'closed'),event(4,5,'active'),event(5,7,'pending'),event(6,9,'active')]);
 assert.deepEqual(deltas(row,[2,4,5,6,8,10]),[0,-1,-1,0,-1,0]);
});
test('new tickets cancel correctly when working backward; boundary event belongs to the new week',()=>{
 assert.deepEqual(deltas(ticket([event(1,4,'active')],'active',{createdAt:at(4)}),[2,4,5]),[-1,-1,0]);
});
test('drafts and hidden threads cannot change status history',()=>{
 assert.deepEqual(deltas(ticket([event(1,1,'active'),event(2,3,'closed',{type:'message',state:'draft'})]),[4]),[0]);
});
test('same-second close line item takes precedence over reply, conflicting status actions stay unknown',()=>{
 assert.deepEqual(deltas(ticket([event(1,1,'active'),event(2,3,'active',{type:'message',state:'published'}),event(3,3,'closed')],'closed',{threads:1}),[4]),[0]);
 assert.deepEqual(deltas(ticket([event(1,1,'active'),event(2,3,'active'),event(3,3,'pending'),event(4,5,'active')]),[4,6]),[null,0]);
});
test('merge prevents reconstruction before merge, later verified boundaries can recover',()=>{
 const row=ticket([event(1,1,'active'),event(2,3,'active',{action:{type:'merged'}}),event(3,5,'closed')],'closed');
 assert.deepEqual(deltas(row,[2,4,6]),[null,1,0]);
});
test('missing histories, truncated threads and latest-state mismatch produce gaps',()=>{
 assert.deepEqual(deltas(ticket([]),[2]),[null]);
 assert.deepEqual(deltas(ticket([event(1,1,'active')],'active',{threads:1}),[2]),[null]);
 assert.deepEqual(deltas(ticket([event(1,1,'active'),event(2,5,'pending')],'closed'),[4,6]),[1,null]);
});
test('pagination rejects missing pages, duplicate or unordered tickets',()=>{
 const data={page:{number:1,totalElements:2,totalPages:1},_embedded:{conversations:[{number:2},{number:1}]}};
 assert.equal(validateHistoryPage(data,1).length,2);
 assert.throws(()=>validateHistoryPage(data,2));
 data._embedded.conversations[1].number=2;
 assert.throws(()=>validateHistoryPage(data,1));
});
