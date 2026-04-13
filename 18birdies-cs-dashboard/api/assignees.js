import { fetchWeekAssignees } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start or end query params' });
  }

  try {
    const assignees = await fetchWeekAssignees(start, end);
    return res.status(200).json({ start, end, assignees });
  } catch (err) {
    console.error('Assignees error:', err);
    return res.status(500).json({ error: err.message });
  }
}
