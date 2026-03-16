// POST /api/refresh
// Forces a fresh pull from HelpScout, bypassing cache

import { fetchAllMetrics } from '../lib/helpscout.js';
import { storeSnapshot } from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = await fetchAllMetrics();
    await storeSnapshot('snapshot:metrics:all', data);
    await storeSnapshot(`snapshot:weekly:${data.fetchedAt.slice(0, 10)}`, data);

    return res.status(200).json({ ok: true, fetchedAt: data.fetchedAt, weeks: data.weeks.length });
  } catch (err) {
    console.error('Refresh error:', err);
    return res.status(500).json({ error: err.message });
  }
}
