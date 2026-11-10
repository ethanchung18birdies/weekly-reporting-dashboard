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
| `HELPSCOUT_APP_ID` | Your Help Scout app ID |
| `HELPSCOUT_APP_SECRET` | Your Help Scout app secret |
| `HELPSCOUT_MAILBOX_ID` | Your Help Scout mailbox ID |
| `EXPORT_ACCESS_TOKEN` | Optional extra token for ticket export routes |
| `HELPSCOUT_RETRY_ATTEMPTS` | Optional; Help Scout retry attempts for 429/5xx responses. Default `6` |
| `HELPSCOUT_429_FALLBACK_MS` | Optional; wait time when Help Scout says minute rate limit but returns `retry_after:0`. Default `65000` |
| `HELPSCOUT_SERVER_WAIT_LIMIT_MS` | Optional; max time a serverless request will sleep before asking the browser to retry. Default `25000` |
| `TICKET_THREAD_CONCURRENCY` | Optional; concurrent ticket thread fetches. Default `2` |
| `TICKET_THREAD_DELAY_MS` | Optional; minimum delay between thread fetch starts. Default `125` |
| `TICKET_EXPORT_TIME_BUDGET_MS` | Optional; time budget before exporting remaining rows as not processed. Default `45000` |
| `BASE_URL` | `https://18birdies-cs-dashboard.vercel.app` |

Then click **Redeploy** to pick up the new env vars.

### 4. Share with Execs

Your dashboard is live at:
```
https://18birdies-cs-dashboard.vercel.app
```

Anyone with the link can view and refresh it. No login required.

---

## Optional: Password Protection

To restrict access, go to Vercel → your project → **Settings → Password Protection** and enable it. Anyone visiting will need to enter a password you set.

## Backlog and ticket-flow definitions

- **Current backlog** is the live Conversations API count for `status=active` in the configured mailbox, across channels. Pending conversations are excluded. It remains live when selecting an older report week. Missing counts display as unavailable, never zero.
- **Net ticket flow** is the selected week's email `resolutions.closed − volume.emailConversations`. Use all closes, including closes without a reply; `resolutions.resolved` is the separate closed-with-reply metric. Positive means more closed than opened. This balance does not measure changes in the active backlog: channel scope and status transitions can differ.
- **Recorded backlog by week** plots only observed API counts, with the latest observation in each Monday–Sunday UTC report week. Tooltips show observation times. It is not a week-end census. Missing weeks remain blank; historical counts are never reconstructed from email activity. Comparisons require observations in both adjacent weeks.
- Backlog forecasts based on email activity have been removed. Failed weekly report requests return an API error instead of fabricated zero activity.

Definitions: [Help Scout Email Report](https://developer.helpscout.com/mailbox-api/endpoints/reports/email/) and [List Conversations](https://developer.helpscout.com/mailbox-api/endpoints/conversations/list/).

## Backlog history storage

Every metrics fetch records a valid live count. With `KV_REST_API_URL` and `KV_REST_API_TOKEN` configured for a Redis REST store, the API saves shared history, scoped by mailbox and active status, using timestamp-ordered observations. Weekly keys expire after one year. This uses the REST API directly and needs no optional SDK.

Without shared storage, or if it fails, the dashboard explicitly saves history in browser local storage. That history is device/browser-specific and can be cleared. The UI states which storage is in use. Blocked local storage does not prevent displaying live metrics.

Only dashboard refreshes capture observations; there is no scheduled collection or historical backfill. No manually supplied backlog counts are seeded.

## Local Development

```bash
npm install -g vercel
vercel dev
```

Open `http://localhost:3000`

Run regression checks with `npm test` (Node.js 20+). Tests cover API field mapping, failed reports and missing counts, history gaps, persistence fallback, and the displayed KPI/chart calculations.

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/metrics` | Fetches last 12 weeks of metrics, live active backlog, and recorded backlog history |
| `GET /api/metrics?refresh=true` | Same fresh pull; retained for the dashboard Refresh button |
| `GET /api/buckets` | Returns selected-week category/subcategory buckets |
| `GET /api/assignees` | Returns selected-week closed volume by assignee |
| `GET /api/assignee-subcategories` | Returns selected-assignee subcategory drilldown |
| `GET /api/ticket-assignees` | Returns Help Scout assignees and ticket export filter options |
| `GET /api/ticket-search` | Returns a paginated ticket preview for selected filters |
| `POST /api/ticket-export-plan` | Prepares a full ticket export list |
| `POST /api/ticket-export-batch` | Fetches full ticket messages for one export batch |
| `POST /api/ticket-export-workbook` | Builds the final XLSX workbook |
| `POST /api/ticket-export-stream` | Legacy single-request XLSX export stream |

## Files

```
├── api/
│   ├── metrics.js          # Main weekly metrics endpoint
│   ├── buckets.js          # Category/subcategory bucket endpoint
│   ├── assignees.js        # Assignee volume endpoint
│   └── ticket-*.js         # Ticket search/export endpoints
├── lib/
│   ├── helpscout.js        # HelpScout API client + data fetching
│   ├── backlog-history.js  # Optional shared recorded backlog history
│   └── store.js            # Data persistence (KV or in-memory)
├── public/
│   └── index.html          # Full dashboard UI
│   └── backlog-metrics.js  # Backlog observations and ticket-flow calculations
├── .env.local              # Local credentials (never commit this)
├── .env.example            # Template for env vars
├── vercel.json             # Routing config
└── package.json
```
