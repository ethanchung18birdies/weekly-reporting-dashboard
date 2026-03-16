const TOKEN_URL = 'https://api.helpscout.net/v2/authentication/token';
const HELPSCOUT_API = 'https://api.helpscout.net/v2';

export default async function handler(req, res) {
  const appId = process.env.HELPSCOUT_APP_ID;
  const appSecret = process.env.HELPSCOUT_APP_SECRET;
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;

  try {
    // HelpScout requires Basic Auth header + form body
    const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: 'grant_type=client_credentials',
    });

    const tokenText = await tokenRes.text();

    if (!tokenRes.ok) {
      return res.status(200).json({
        step: 'auth_failed',
        status: tokenRes.status,
        error: tokenText,
        hint: 'Auth format issue',
      });
    }

    const { access_token } = JSON.parse(tokenText);

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
      auth: 'success',
      active_tickets: testData?.page?.totalElements ?? 'error',
      mailboxes: mailboxes.map(m => ({ id: m.id, name: m.name, email: m.email })),
    });
  } catch (err) {
    return res.status(200).json({
      step: 'exception',
      error: err.message,
    });
  }
}
