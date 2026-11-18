// Active stock is reconstructed from status at each boundary, not report totals.
// Unchanged tickets cancel: B(then) = B(now) + sum(activeThen - activeNow).
const STATUSES = new Set(['active', 'pending', 'closed', 'spam']);
const STRUCTURAL = /merge|mov|delet/i;

export function conversationBoundaryDeltas(conversation, boundaries) {
  const created = Date.parse(conversation.createdAt);
  const threads = conversation._embedded?.threads;
  const unavailable = reason => boundaries.map(() => ({ delta: null, reason }));
  if (!Number.isFinite(created) || !STATUSES.has(conversation.status)
      || !Array.isArray(threads)) return unavailable('missing_history');

  const unique = new Map();
  for (const thread of threads) {
    if (!thread.id || !Number.isFinite(Date.parse(thread.createdAt))) return unavailable('invalid_event');
    if (unique.has(thread.id)) return unavailable('duplicate_event');
    unique.set(thread.id, thread);
  }
  const published = threads.filter(t => t.type !== 'lineitem' && t.state === 'published').length;
  if (!Number.isInteger(conversation.threads) || published < conversation.threads) {
    return unavailable('incomplete_threads');
  }
  const events = threads.filter(t => t.type === 'lineitem' || t.state === 'published');
  const groups = new Map();
  let structuralAt = -Infinity;
  for (const event of events) {
    const time = Date.parse(event.createdAt);
    if (STRUCTURAL.test(event.action?.type || '')) structuralAt = Math.max(structuralAt, time);
    if (!event.status) continue;
    const group = groups.get(time) || [];
    group.push(event);
    groups.set(time, group);
  }
  const states = [...groups].sort(([a], [b]) => a - b).map(([time, group]) => {
    const statuses = new Set(group.map(e => e.status));
    let status = statuses.size === 1 ? group[0].status : null;
    // A separate closing line item can accompany a reply in the same second.
    // Other conflicting timestamps have no trustworthy ordering.
    const lines = group.filter(e => e.type === 'lineitem');
    const messages = group.filter(e => e.type !== 'lineitem');
    if (!status && lines.length === 1 && lines[0].status === 'closed'
        && messages.length && messages.every(e => ['active', 'pending'].includes(e.status))) status = 'closed';
    return { time, status: STATUSES.has(status) ? status : null };
  });
  const latest = states.at(-1);
  return boundaries.map(boundary => {
    const time = Date.parse(boundary);
    // Merges erase the separate source identity; a status alone cannot recover
    // its former contribution. Never silently count the surviving ticket only.
    if (structuralAt >= time) return { delta: null, reason: 'merge_move_or_delete' };
    if (created >= time) return { delta: -Number(conversation.status === 'active') };
    if (latest && latest.time < time && latest.status !== conversation.status) {
      return { delta: null, reason: 'latest_state_mismatch' };
    }
    const state = states.findLast(s => s.time < time);
    if (!state?.status) return { delta: null, reason: state ? 'ambiguous_status' : 'missing_initial_state' };
    return { delta: Number(state.status === 'active') - Number(conversation.status === 'active') };
  });
}

export function summarizeHistoryPage(conversations, boundaries) {
  const points = boundaries.map(at => ({ at, delta: 0, unknownTickets: 0, reasons: {} }));
  for (const conversation of conversations) {
    conversationBoundaryDeltas(conversation, boundaries).forEach((result, i) => {
      if (result.delta === null) {
        points[i].unknownTickets++;
        points[i].reasons[result.reason] = (points[i].reasons[result.reason] || 0) + 1;
      } else points[i].delta += result.delta;
    });
  }
  return points;
}

export function validateHistoryPage(data, page) {
  const p = data?.page;
  const rows = data?._embedded?.conversations ?? (p?.totalElements === 0 ? [] : null);
  if (!Number.isInteger(p?.totalElements) || p.totalElements < 0
      || !Number.isInteger(p?.totalPages) || p.totalPages < 0
      || (p.totalElements > 0 && p.number !== page) || !Array.isArray(rows)
      || (p.totalElements > 0 && rows.length === 0)) throw new Error('Incomplete history pagination');
  const numbers = rows.map(r => r.number);
  if (numbers.some(n => !Number.isInteger(n)) || numbers.some((n, i) => i && n >= numbers[i - 1])) {
    throw new Error('History order is inconsistent');
  }
  return rows;
}
