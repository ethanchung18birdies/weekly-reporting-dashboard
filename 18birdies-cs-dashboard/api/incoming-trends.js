import { fetchIncomingTrendWindow } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start or end query params' });
  }

  try {
    const data = await fetchIncomingTrendWindow(start, end);
    return res.status(200).json(data);
  } catch (err) {
    console.error('Incoming trends error:', err);
    return res.status(500).json({
      error: 'Failed to fetch incoming trends',
      detail: err.message,
    });
  }
}
