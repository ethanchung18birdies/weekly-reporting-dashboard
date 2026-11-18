import { hsGetWithRetry, getWeekRanges, getCurrentBacklog } from '../lib/helpscout.js';
import { reportBounds } from '../lib/reporting-time.js';
import { summarizeHistoryPage, validateHistoryPage } from '../lib/backlog-history.js';

// Bounded batches keep large mailboxes out of a single serverless request.
// Only aggregate counts leave this endpoint; no message text or ticket details.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const page = Number(req.query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) return res.status(400).json({ error: 'Invalid page' });
    const weeks = getWeekRanges(12);
    const boundaries = weeks.map(w => reportBounds(w.startStr, w.startStr).start);
    const params = { mailbox: process.env.HELPSCOUT_MAILBOX_ID, status: 'all', modifiedSince: boundaries[0] };
    const startedAt = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const previous = req.query.marker ? JSON.parse(req.query.marker) : null;
    if (previous && (previous[0] !== boundaries[0] || !Number.isInteger(previous[1])
        || !Number.isFinite(Date.parse(previous[2])) || Date.parse(previous[2]) > Date.now())) {
      return res.status(409).json({ error: 'History scan expired' });
    }
    if (req.query.verify === 'true') {
      if (!previous) return res.status(400).json({ error: 'Missing scan marker' });
      const anchor = await getCurrentBacklog();
      const population = await hsGetWithRetry('/conversations', { ...params, page: 1 }, 2);
      const changed = await hsGetWithRetry('/conversations', { ...params, modifiedSince: previous[2], page: 1 }, 2);
      if (anchor.total === null || population?.page?.totalElements !== previous[1]
          || changed?.page?.totalElements !== 0) return res.status(409).json({ error: 'Tickets changed during history scan; refresh to retry' });
      return res.status(200).json({ currentBacklog: anchor.total, fetchedAt: new Date().toISOString(), marker: req.query.marker });
    }
    const data = await hsGetWithRetry('/conversations', { ...params, embed: 'threads', sortField: 'number', sortOrder: 'desc', page }, 2);
    const rows = validateHistoryPage(data, page);
    if (previous && previous[1] !== data.page.totalElements) throw new Error('History population changed');
    const marker = req.query.marker || JSON.stringify([boundaries[0], data.page.totalElements, startedAt]);
    return res.status(200).json({ weeks, points: summarizeHistoryPage(rows, boundaries), marker,
      page, totalPages: data.page.totalPages, totalElements: data.page.totalElements,
      count: rows.length, firstNumber: rows[0]?.number ?? null, lastNumber: rows.at(-1)?.number ?? null,
      nextPage: page < data.page.totalPages ? page + 1 : null });
  } catch (error) {
    console.error('Backlog history unavailable:', error.message);
    return res.status(503).json({ error: 'Ticket status history is unavailable; current backlog is unaffected' });
  }
}
