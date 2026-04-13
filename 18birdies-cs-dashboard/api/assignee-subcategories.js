import { fetchAssigneeSubcategories } from '../lib/helpscout.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { start, end, assignee } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start or end query params' });
  }

  try {
    const data = await fetchAssigneeSubcategories(start, end, assignee || 'all');
    return res.status(200).json({
      start,
      end,
      assignee: assignee || 'all',
      ...data,
    });
  } catch (err) {
    console.error('Assignee subcategories error:', err);
    return res.status(500).json({
      error: 'Failed to load assignee subcategory data',
      detail: err.message,
    });
  }
}
