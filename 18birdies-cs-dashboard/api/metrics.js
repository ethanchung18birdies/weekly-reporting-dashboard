import { fetchDashboardData } from '../lib/helpscout.js';
import { getCache, setCache } from '../lib/store.js';

const CACHE_KEY = 'dashboard_metrics';
const TTL_MS = 30 * 60 * 1000; // 30 min

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cached = await getCache(CACHE_KEY);
    if (cached && Date.now() - cached.timestamp < TTL_MS) {
      return res.status(200).json(cached.data);
    }

    const data = await fetchDashboardData();

    await setCache(CACHE_KEY, {
      timestamp: Date.now(),
      data,
    });

    return res.status(200).json(data);
  } catch (err) {
    console.error('Metrics error:', err);
    return res.status(500).json({
      error: 'Failed to fetch metrics from HelpScout',
      detail: err.message,
    });
  }
}
