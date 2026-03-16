// GET /api/metrics
// Returns all weekly metrics for the dashboard
// Cached for 30 minutes to avoid hammering HelpScout API

import { fetchAllMetrics } from '../lib/helpscout.js';
import { storeSnapshot, getSnapshot } from '../lib/store.js';

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cacheKey = 'snapshot:metrics:all';
    const force = req.query.refresh === 'true';

    // Check cache
    if (!force) {
      const cached = await getSnapshot(cacheKey);
      if (cached && cached.fetchedAt) {
        const age = Date.now() - new Date(cached.fetchedAt).getTime();
        if (age < CACHE_TTL) {
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('X-Cache-Age', Math.round(age / 1000) + 's');
          return res.status(200).json(cached);
        }
      }
    }

    // Fetch fresh data
    res.setHeader('X-Cache', 'MISS');
    const data = await fetchAllMetrics();

    // Store in cache and persist as historical snapshot
    await storeSnapshot(cacheKey, data);
    await storeSnapshot(`snapshot:weekly:${data.fetchedAt.slice(0, 10)}`, data);

    return res.status(200).json(data);
  } catch (err) {
    console.error('Metrics error:', err);
    return res.status(500).json({
      error: 'Failed to fetch metrics from HelpScout',
      detail: err.message,
    });
  }
}
