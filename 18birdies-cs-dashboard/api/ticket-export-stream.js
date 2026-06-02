import { assertExportAccess, readJsonBody } from '../lib/apiSecurity.js';
import {
  enrichTicketConversations,
  listTicketConversations,
  ticketRowsToSheet,
} from '../lib/helpscout.js';
import { buildXlsxBuffer } from '../lib/xlsx.js';

function sendEvent(res, event) {
  res.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

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
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      error: 'Ticket export access denied',
      detail: err.message,
    });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const body = await readJsonBody(req);
    const filters = body.filters || {};
    const columns = body.columns || [];

    sendEvent(res, {
      type: 'progress',
      phase: 'indexing',
      label: 'Finding matching conversations',
      processed: 0,
      total: 0,
    });

    const { conversations, capped } = await listTicketConversations(filters, {
      maxRows: Infinity,
      onProgress(progress) {
        sendEvent(res, {
          type: 'progress',
          label: 'Finding matching conversations',
          ...progress,
        });
      },
    });

    sendEvent(res, {
      type: 'progress',
      phase: 'fetching_threads',
      label: 'Fetching full customer messages',
      processed: 0,
      total: conversations.length,
      capped,
    });

    const { rows, errors } = await enrichTicketConversations(conversations, {
      query: filters.query,
      onProgress(progress) {
        sendEvent(res, {
          type: 'progress',
          label: 'Fetching full customer messages',
          ...progress,
        });
      },
    });

    sendEvent(res, {
      type: 'progress',
      phase: 'building_xlsx',
      label: 'Building XLSX',
      processed: rows.length,
      total: rows.length,
      errors,
    });

    const sheetRows = ticketRowsToSheet(rows, columns);
    const workbook = buildXlsxBuffer([
      { name: 'Tickets', rows: sheetRows.length ? sheetRows : [['No matching tickets']] },
    ]);
    const filename = `helpscout_tickets_${safeFileDate(filters.start)}_${safeFileDate(filters.end)}.xlsx`;

    sendEvent(res, {
      type: 'complete',
      phase: 'complete',
      filename,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      rowCount: rows.length,
      errors,
      capped,
      fileBase64: workbook.toString('base64'),
    });

    res.end();
  } catch (err) {
    console.error('Ticket export stream error:', err);
    sendEvent(res, {
      type: 'error',
      phase: 'error',
      error: 'Failed to export tickets',
      detail: err.message,
    });
    res.end();
  }
}
