import { createHash } from 'node:crypto';
const STATUSES = new Set(['active', 'pending', 'closed', 'spam']);
export const historyKey = id => createHash('sha256').update(String(id)).digest('hex').slice(0,24);
const originalId = event => {
  const value = event.action?.associatedEntities?.originalConversation;
  return typeof value === 'object' ? value?.id : value;
};

function statesFor(events) {
  const groups = new Map();
  for (const event of events) {
    if (!event.status) continue;
    const time = Date.parse(event.createdAt);
    const group = groups.get(time) || []; group.push(event); groups.set(time, group);
  }
  return [...groups].sort(([a],[b]) => a-b).map(([time, group]) => {
    const statuses = new Set(group.map(e => e.status));
    let status = statuses.size === 1 ? group[0].status : null;
    const lines = group.filter(e => e.type === 'lineitem');
    const messages = group.filter(e => e.type !== 'lineitem');
    if (!status && lines.length === 1 && lines[0].status === 'closed' && messages.length
        && messages.every(e => ['active','pending'].includes(e.status))) status = 'closed';
    return { time, status: STATUSES.has(status) ? status : null };
  });
}

// Return separate contributions for the surviving conversation and each merged
// source. Imported source threads must never overwrite the survivor's history.
export function conversationHistoryEntries(conversation, boundaries) {
  const threads = conversation._embedded?.threads;
  const current = Number(conversation.status === 'active');
  const created = Date.parse(conversation.createdAt);
  const sourceGroups = new Map();
  const ownEvents = [];
  let invalid = !Array.isArray(threads) || !Number.isFinite(created) || !STATUSES.has(conversation.status);
  const unique = new Set();
  for (const event of threads || []) {
    if (!event.id || unique.has(event.id) || !Number.isFinite(Date.parse(event.createdAt))) invalid = true;
    unique.add(event.id);
    if (event.type !== 'lineitem' && event.state !== 'published') continue;
    const source = originalId(event);
    if (source && String(source) !== String(conversation.id)) {
      const group = sourceGroups.get(String(source)) || []; group.push(event); sourceGroups.set(String(source),group);
    } else ownEvents.push(event);
  }
  const published = (threads || []).filter(e => e.type !== 'lineitem' && e.state === 'published').length;
  if (!Number.isInteger(conversation.threads) || published < conversation.threads) invalid = true;
  const ownStates = statesFor(ownEvents);
  const latest = ownStates.at(-1);
  const structural = ownEvents.filter(e => /mov|delet/i.test(e.action?.type || ''));
  const entries = [{ key: historyKey(conversation.id), priority: 2,
    points: boundaries.map(at => {
      const time = Date.parse(at);
      if (Number.isFinite(created) && created >= time) return { low: -current, high: -current };
      const state = ownStates.findLast(s => s.time < time);
      const unknown = invalid || !state?.status || structural.some(e => Date.parse(e.createdAt) >= time)
        || (latest?.time < time && latest.status !== conversation.status);
      return unknown ? { low: -current, high: 1-current, reason: 'uncertain_status' }
        : { low: Number(state.status === 'active')-current, high: Number(state.status === 'active')-current };
    }) }];
  for (const [source, events] of sourceGroups) {
    const states = statesFor(events);
    // The import line item's timestamp is the merge time; imported messages
    // retain their original timestamps, which can be much earlier.
    const mergeTimes = events.filter(e => e.type === 'lineitem' && e.action?.type === 'merged').map(e => Date.parse(e.createdAt));
    const mergedAt = mergeTimes.length ? Math.max(...mergeTimes) : Infinity;
    entries.push({ key: historyKey(source), priority: 1, points: boundaries.map(at => {
      const time = Date.parse(at);
      if (time > mergedAt) return { low: 0, high: 0 };
      const state = states.findLast(s => s.time < time);
      // No original creation date survives a redirected source ID. Before its
      // first retained event the source contributes 0–1, not an invented zero.
      return invalid || !state?.status ? { low: 0, high: 1, reason: 'merged_source_unknown' }
        : { low: Number(state.status === 'active'), high: Number(state.status === 'active') };
    }) });
  }
  // Some older merges omit the source ID. Each merge line item represents one
  // additional identity, but its historical Active status remains uncertain.
  for (const event of ownEvents.filter(e => e.type === 'lineitem' && e.action?.type === 'merged' && !originalId(e))) {
    entries.push({ key: historyKey(`merge:${event.id}`), priority: 0, points: boundaries.map(at =>
      Date.parse(at) <= Date.parse(event.createdAt) ? {low:0,high:1,reason:'merged_source_unknown'} : {low:0,high:0}) });
  }
  return entries;
}

export function summarizeHistoryEntries(entries, boundaries) {
  const unique = new Map();
  for (const entry of entries) if (!unique.has(entry.key) || unique.get(entry.key).priority < entry.priority) unique.set(entry.key,entry);
  const points = boundaries.map(at => ({at,low:0,high:0,unknownTickets:0}));
  for (const entry of unique.values()) entry.points.forEach((p,i) => {
    points[i].low += p.low; points[i].high += p.high;
    points[i].unknownTickets += Number(p.low !== p.high);
  });
  return points;
}

export function buildHistorySnapshot(weeks, points, currentBacklog, adjustment = 0, uncertainty = 0, fetchedAt = new Date().toISOString()) {
  const starts = points.map(p => {
    const low=currentBacklog+adjustment+p.low-uncertainty, high=currentBacklog+adjustment+p.high+uncertainty;
    return high < 0 ? null : {low:Math.max(0,low),high};
  });
  return {version:2,fetchedAt,scope:'Available Help Scout status history; inaccessible deleted or moved-out tickets are not recoverable',
    weeks:weeks.map((w,i)=>({...w,startRange:starts[i],endRange:i===weeks.length-1?null:starts[i+1]}))};
}

export function validateHistoryPage(data, page) {
  const p=data?.page, rows=data?._embedded?.conversations ?? (p?.totalElements===0?[]:null);
  if (!Number.isInteger(p?.totalElements)||p.totalElements<0||!Number.isInteger(p?.totalPages)||p.totalPages<0
      ||(p.totalElements>0&&p.number!==page)||!Array.isArray(rows)||(p.totalElements>0&&!rows.length)) throw new Error('Incomplete history pagination');
  const numbers=rows.map(r=>r.number);
  if(numbers.some(n=>!Number.isInteger(n))||numbers.some((n,i)=>i&&n>=numbers[i-1]))throw new Error('History order is inconsistent');
  return rows;
}
