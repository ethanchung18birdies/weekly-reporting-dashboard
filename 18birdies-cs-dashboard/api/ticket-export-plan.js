import { assertExportAccess, readJsonBody } from '../lib/apiSecurity.js';
import {
  listTicketConversations,
  ticketConversationToSeed,
} from '../lib/helpscout.js';

function safeFileDate(value) {
  return String(value || '')
    .slice(0, 10)
    .replace(/[^0-9-]/g, '') || 'tickets';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    assertExportAccess(req);
    const body = await readJsonBody(req);
    const filters = body.filters || {};

    const { conversations, capped } = await listTicketConversations(filters, {
      maxRows: null,
    });

    return res.status(200).json({
      seeds: conversations.map(ticketConversationToSeed),
      total: conversations.length,
      capped,
      filename: `helpscout_tickets_${safeFileDate(filters.start)}_${safeFileDate(filters.end)}.xlsx`,
    });
  } catch (err) {
    console.error('Ticket export plan error:', err);
    return res.status(err.statusCode || 500).json({
      error: 'Failed to prepare ticket export',
      detail: err.message,
    });
  }
}
