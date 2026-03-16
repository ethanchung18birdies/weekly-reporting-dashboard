const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';
const HELPSCOUT_API = 'https://api.helpscout.net/v2';

export default async function handler(req, res) {
  const appId = process.env.HELPSCOUT_APP_ID;
  const appSecret = process.env.HELPSCOUT_APP_SECRET;
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;

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
      return res.status(200).json({ step: 'auth_failed', error: await tokenRes.text() });
    }
    const { access_token } = await tokenRes.json();

    // Test the reports/email endpoint for this week
    const now = new Date();
    const start = '2026-03-09T00:00:00Z';
    const end = '2026-03-15T23:59:59Z';

    const [emailReport, companyReport, backlogActive, backlogPending] = await Promise.all([
      fetch(`${HELPSCOUT_API}/reports/email?start=${start}&end=${end}&mailbox=${mailboxId}`, {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then(r => r.json()),
      fetch(`${HELPSCOUT_API}/reports/company?start=${start}&end=${end}&mailbox=${mailboxId}`, {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then(r => r.json()),
      fetch(`${HELPSCOUT_API}/conversations?mailbox=${mailboxId}&status=active&pageSize=1`, {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then(r => r.json()),
      fetch(`${HELPSCOUT_API}/conversations?mailbox=${mailboxId}&status=pending&pageSize=1`, {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then(r => r.json()),
    ]);

    return res.status(200).json({
      auth: 'success',
      period: { start, end },
      backlog: {
        active: backlogActive?.page?.totalElements,
        pending: backlogPending?.page?.totalElements,
      },
      emailReport_current: emailReport?.current,
      companyReport_current: companyReport?.current,
      raw_email_error: emailReport?.error || null,
      raw_company_error: companyReport?.error || null,
    });
  } catch (err) {
    return res.status(200).json({ step: 'exception', error: err.message });
  }
}
