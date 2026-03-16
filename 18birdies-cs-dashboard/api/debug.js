const TOKEN_URL = 'https://api.helpscout.net/v2/authentication/token';
const HELPSCOUT_API = 'https://api.helpscout.net/v2';

export default async function handler(req, res) {
  const appId = process.env.HELPSCOUT_APP_ID;
  const appSecret = process.env.HELPSCOUT_APP_SECRET;
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;

  const envCheck = {
    HELPSCOUT_APP_ID: appId ? `set (${appId.length} chars, starts: ${appId.slice(0,4)}...)` : 'MISSING',
    HELPSCOUT_APP_SECRET: appSecret ? `set (${appSecret.length} chars, starts: ${appSecret.slice(0,4)}...)` : 'MISSING',
    HELPSCOUT_MAILBOX_ID: mailboxId ? `set — value: ${mailboxId}` : 'MISSING',
  };

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: appSecret,
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(200).json({
        env: envCheck,
        step: 'auth_failed',
        status: tokenRes.status,
        error: err,
      });
    }

    const { access_token } = await tokenRes.json();

    const mailboxRes = await fetch(`${HELPSCOUT_API}/mailboxes`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const mailboxData = await mailboxRes.json();
    const mailboxes = mailboxData?._embedded?.mailboxes || [];

    const testRes = await fetch(
      `${HELPSCOUT_API}/conversations?mailbox=${mailboxId}&status=active&pageSize=1`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const testData = await testRes.json();

    return res.status(200).json({
      env: envCheck,
      auth: 'success',
      active_tickets_with_current_id: testData?.page?.totalElements ?? 'error',
      your_mailboxes: mailboxes.map(m => ({ id: m.id, name: m.name, email: m.email })),
    });
  } catch (err) {
    return res.status(200).json({
      env: envCheck,
      step: 'exception',
      error: err.message,
    });
  }
}
