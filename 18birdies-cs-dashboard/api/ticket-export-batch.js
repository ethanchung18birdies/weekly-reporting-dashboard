import { assertExportAccess, readJsonBody } from '../lib/apiSecurity.js';
import { enrichTicketSeedRows } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    assertExportAccess(req);
    const body = await readJsonBody(req);
    const seeds = Array.isArray(body.seeds) ? body.seeds : [];

    const { rows, errors } = await enrichTicketSeedRows(seeds);

    return res.status(200).json({
      rows,
      errors,
      total: seeds.length,
    });
  } catch (err) {
    console.error('Ticket export batch error:', err);
    return res.status(err.statusCode || 500).json({
      error: 'Failed to fetch ticket batch',
      detail: err.message,
      retryAfterMs: err.retryAfterMs || null,
    });
  }
}
