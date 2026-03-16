// GET /api/debug
// Temporary endpoint to verify HelpScout connection and find correct mailbox IDs
// You can delete this file after setup is complete

const TOKEN_URL = 'https://api.helpscout.net/v2/authentication/token';
const HELPSCOUT_API = 'https://api.helpscout.net/v2';

export default async function handler(req, res) {
  try {
    // Step 1: Get access token
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.HELPSCOUT_APP_ID,
      client_secret: process.env.HELPSCOUT_APP_SECRET,
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(200).json({
        step: 'auth_failed',
        status: tokenRes.status,
        error: err,
        hint: 'Check HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET in Vercel env vars',
      });
    }

    const { access_token } = await tokenRes.json();

    // Step 2: Fetch mailboxes
    const mailboxRes = await fetch(`${HELPSCOUT_API}/mailboxes`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const mailboxData = await mailboxRes.json();
    const mailboxes = mailboxData?._embedded?.mailboxes || [];

    // Step 3: Test conversation count with current mailbox ID
    const currentMailboxId = process.env.HELPSCOUT_MAILBOX_ID;
    const testRes = await fetch(
      `${HELPSCOUT_API}/conversations?mailbox=${currentMailboxId}&status=active&pageSize=1`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const testData = await testRes.json();

    return res.status(200).json({
      auth: 'success',
      current_mailbox_id_in_env: currentMailboxId,
      active_tickets_with_current_id: testData?.page?.totalElements ?? 'error',
      your_mailboxes: mailboxes.map(m => ({
        id: m.id,
        name: m.name,
        email: m.email,
      })),
      hint: 'Use the id value from your_mailboxes as HELPSCOUT_MAILBOX_ID',
    });
  } catch (err) {
    return res.status(200).json({
      step: 'exception',
      error: err.message,
    });
  }
}
