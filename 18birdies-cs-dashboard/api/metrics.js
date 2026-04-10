import { fetchDashboardData } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = await fetchDashboardData();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Metrics error:', err);
    return res.status(500).json({
      error: 'Failed to fetch metrics from HelpScout',
      detail: err.message,
    });
  }
}
