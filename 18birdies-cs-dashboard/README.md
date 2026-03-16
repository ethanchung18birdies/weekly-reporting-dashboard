# 18Birdies CS Operations Dashboard

Live HelpScout dashboard showing backlog burndown, weekly metrics, and efficiency trends for executives.

## Deploy in 5 minutes

### 1. Push to GitHub

Create a new GitHub repo (can be private) and push this folder:

```bash
git init
git add .
git commit -m "Initial dashboard"
git remote add origin https://github.com/YOUR_ORG/18birdies-cs-dashboard.git
git push -u origin main
```

### 2. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. Click **Deploy** (no build settings needed)

### 3. Add Environment Variables

In Vercel → your project → **Settings → Environment Variables**, add:

| Key | Value |
|-----|-------|
| `HELPSCOUT_APP_ID` | `LTrKhFByBzdyYRp3qRZBmcQqx4bXUXrC` |
| `HELPSCOUT_APP_SECRET` | `CnXCKhHaMCw7AxUEsjIQoqKMYI6rfAN9` |
| `HELPSCOUT_MAILBOX_ID` | `91a5369bcb61860e` |
| `BASE_URL` | `https://18birdies-cs-dashboard.vercel.app` |

Then click **Redeploy** to pick up the new env vars.

### 4. Update HelpScout Redirect URL (optional)

If HelpScout prompts you, update your app's redirect URL to:
```
https://18birdies-cs-dashboard.vercel.app/api/auth/callback
```

### 5. Share with Execs

Your dashboard is live at:
```
https://18birdies-cs-dashboard.vercel.app
```

Anyone with the link can view and refresh it. No login required.

---

## Optional: Password Protection

To restrict access, go to Vercel → your project → **Settings → Password Protection** and enable it. Anyone visiting will need to enter a password you set.

## Optional: Persist Historical Data (Vercel KV)

By default, weekly snapshots are stored in memory (lost on redeploy). To persist history:

1. In Vercel → your project → **Storage → Create KV Database**
2. Connect it to your project — Vercel auto-adds the env vars
3. Redeploy — history now survives across deploys

## Local Development

```bash
npm install -g vercel
vercel dev
```

Open `http://localhost:3000`

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/metrics` | Returns last 12 weeks of metrics (cached 30 min) |
| `GET /api/metrics?refresh=true` | Forces fresh pull from HelpScout |
| `POST /api/refresh` | Same as above (for programmatic use) |

## Files

```
├── api/
│   ├── metrics.js          # Main metrics endpoint
│   ├── refresh.js          # Force refresh endpoint
│   └── auth/callback.js    # OAuth2 callback handler
├── lib/
│   ├── helpscout.js        # HelpScout API client + data fetching
│   └── store.js            # Data persistence (KV or in-memory)
├── public/
│   └── index.html          # Full dashboard UI
├── .env.local              # Local credentials (never commit this)
├── .env.example            # Template for env vars
├── vercel.json             # Routing config
└── package.json
```
