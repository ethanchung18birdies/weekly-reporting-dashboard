import {
  TICKET_SEARCH_LIMIT,
  enrichTicketConversations,
  listTicketConversations,
} from '../lib/helpscout.js';
import { assertExportAccess } from '../lib/apiSecurity.js';

function asArray(value) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    assertExportAccess(req);

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(5, Number(req.query.pageSize || 25)));

    const filters = {
      start: req.query.start,
      end: req.query.end,
      status: req.query.status,
      category: req.query.category,
      subcategory: req.query.subcategory,
      query: req.query.query,
      assigneeIds: asArray(req.query.assigneeIds),
    };

    const { conversations, capped } = await listTicketConversations(filters, {
      maxRows: TICKET_SEARCH_LIMIT,
    });

    const offset = (page - 1) * pageSize;
    const pageConversations = conversations.slice(offset, offset + pageSize);
    const { rows, errors } = await enrichTicketConversations(pageConversations, {
      query: filters.query,
    });

    return res.status(200).json({
      rows,
      page,
      pageSize,
      total: conversations.length,
      capped,
      cap: TICKET_SEARCH_LIMIT,
      errors,
    });
  } catch (err) {
    console.error('Ticket search error:', err);
    return res.status(err.statusCode || 500).json({
      error: 'Failed to search tickets',
      detail: err.message,
    });
  }
}
