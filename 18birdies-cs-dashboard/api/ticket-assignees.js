import {
  ALL_TICKET_COLUMNS,
  DEFAULT_TICKET_COLUMNS,
  fetchTicketAssignees,
  getTicketFilterOptions,
} from '../lib/helpscout.js';
import { assertExportAccess } from '../lib/apiSecurity.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    assertExportAccess(req);
    const [assignees, options] = await Promise.all([
      fetchTicketAssignees(),
      Promise.resolve(getTicketFilterOptions()),
    ]);

    return res.status(200).json({
      assignees,
      categories: options.categories,
      subcategories: options.subcategories,
      columns: ALL_TICKET_COLUMNS,
      defaultColumns: DEFAULT_TICKET_COLUMNS.map((column) => column.key),
    });
  } catch (err) {
    console.error('Ticket assignees error:', err);
    return res.status(err.statusCode || 500).json({
      error: 'Failed to load ticket explorer options',
      detail: err.message,
    });
  }
}
