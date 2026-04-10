import { fetchDashboardData } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = await fetchDashboardData();
    return res.status(200).json({
      ok: true,
      refreshedAt: new Date().toISOString(),
      data,
    });
  } catch (err) {
    console.error('Refresh error:', err);
    return res.status(500).json({
      error: 'Failed to refresh metrics from HelpScout',
      detail: err.message,
    });
  }
}
