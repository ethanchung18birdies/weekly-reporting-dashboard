import { fetchIncomingNotTaggedTickets } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { start, end, category = 'all' } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start or end query params' });
  }

  try {
    const data = await fetchIncomingNotTaggedTickets(start, end, category);
    return res.status(200).json(data);
  } catch (err) {
    console.error('Incoming not tagged error:', err);
    return res.status(500).json({
      error: 'Failed to inspect incoming not tagged tickets',
      detail: err.message,
    });
  }
}
