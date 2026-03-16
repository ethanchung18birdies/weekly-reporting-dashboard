// GET /api/auth/callback
// HelpScout OAuth2 redirect target
// For client_credentials flow this isn't strictly needed,
// but HelpScout requires a valid redirect URI when registering the app.

export default async function handler(req, res) {
  // For client_credentials flow, HelpScout never actually redirects here.
  // This endpoint exists to satisfy the OAuth app registration requirement.
  return res.status(200).send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>18Birdies CS Dashboard</h2>
        <p>OAuth callback received. You can close this tab.</p>
      </body>
    </html>
  `);
}
