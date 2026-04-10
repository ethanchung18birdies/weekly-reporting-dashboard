// GET /api/buckets?start=2026-03-09&end=2026-03-15
// Returns tag breakdown for a single week
// Called on demand when a week tab is selected, not during main load

import { fetchWeekBuckets } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start or end query params' });
  }

  try {
    const buckets = await fetchWeekBuckets(start, end);
    return res.status(200).json({ start, end, buckets });
  } catch (err) {
    console.error('Buckets error:', err);
    return res.status(500).json({ error: err.message });
  }
}
