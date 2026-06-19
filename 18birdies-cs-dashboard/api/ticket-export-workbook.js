import { assertExportAccess, readJsonBody } from '../lib/apiSecurity.js';
import { ticketRowsToSheet } from '../lib/helpscout.js';
import { buildXlsxBuffer } from '../lib/xlsx.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    assertExportAccess(req);
    const body = await readJsonBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const columns = body.columns || [];

    const sheetRows = ticketRowsToSheet(rows, columns);
    const workbook = buildXlsxBuffer([
      { name: 'Tickets', rows: sheetRows.length ? sheetRows : [['No matching tickets']] },
    ]);

    return res.status(200).json({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileBase64: workbook.toString('base64'),
      rowCount: rows.length,
    });
  } catch (err) {
    console.error('Ticket export workbook error:', err);
    return res.status(err.statusCode || 500).json({
      error: 'Failed to build ticket workbook',
      detail: err.message,
    });
  }
}
