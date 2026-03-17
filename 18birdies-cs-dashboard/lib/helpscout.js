// HelpScout API v2 client
// Uses Reports API for weekly metrics + Conversations API for live backlog

const HELPSCOUT_API = 'https://api.helpscout.net/v2';
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';

let _tokenCache = null;

async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.HELPSCOUT_APP_ID,
    client_secret: process.env.HELPSCOUT_APP_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HelpScout auth failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _tokenCache.token;
}

async function hsGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${HELPSCOUT_API}${path}`);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HelpScout API error ${res.status} for ${path}: ${err}`);
  }
  return res.json();
}

// ── DATE HELPERS ──────────────────────────────────────────────────────────

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function getWeekRanges(numWeeks = 12) {
  const weeks = [];
  const now = new Date();
  let weekStart = startOfWeek(now);
  for (let i = 0; i < numWeeks; i++) {
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);
    weeks.unshift({
      label: `W${formatDate(weekStart).slice(5).replace('-', '/')}`,
      startStr: formatDate(weekStart),
      endStr: formatDate(weekEnd),
    });
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  }
  return weeks;
}

// ── REPORTS API ───────────────────────────────────────────────────────────

async function getWeekReport(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const params = {
    start: `${startStr}T00:00:00Z`,
    end: `${endStr}T23:59:59Z`,
    mailbox: mailboxId,
  };

  try {
    const emailReport = await hsGet('/reports/email', params).catch(() => null);

    const current = emailReport?.current || {};

    // Opened = emailConversations matches "Email Conversations" in HelpScout Email Report
    const opened = current.volume?.emailConversations ?? 0;

    // Closed = resolved matches "Resolved" in HelpScout Email Report (not .closed which is different)
    const closed = current.resolutions?.resolved ?? 0;

    // Resolution time in seconds — convert to hours
    const resolutionTimeSecs = current.resolutions?.resolutionTime ?? null;
    const resolutionTime = resolutionTimeSecs
      ? Math.round((resolutionTimeSecs / 3600) * 10) / 10
      : null;

    // First response time in seconds — convert to hours
    const frtSecs = current.responses?.firstResponseTime ?? null;
    const firstResponseTime = frtSecs
      ? Math.round((frtSecs / 3600) * 10) / 10
      : null;

    // Resolved on first reply percentage
    const resolvedOnFirstReplyPct = current.resolutions?.percentResolvedOnFirstReply ?? null;

    return { opened, closed, resolutionTime, firstResponseTime, resolvedOnFirstReplyPct };
  } catch (e) {
    console.error(`Error fetching week report ${startStr}-${endStr}:`, e.message);
    return { opened: 0, closed: 0, resolutionTime: null, firstResponseTime: null, repliesPerDay: null };
  }
}

async function getCurrentBacklog() {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  try {
    // active = assigned + unassigned open tickets, pending = awaiting customer reply
    const [activeData, pendingData] = await Promise.all([
      hsGet('/conversations', { mailbox: mailboxId, status: 'active', pageSize: 1 }),
      hsGet('/conversations', { mailbox: mailboxId, status: 'pending', pageSize: 1 }),
    ]);
    const active = activeData?.page?.totalElements || 0;
    const pending = pendingData?.page?.totalElements || 0;
    return { total: active + pending, active, pending };
  } catch (e) {
    console.error('Error fetching backlog:', e.message);
    return { total: 0, active: 0, pending: 0 };
  }
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────

export async function fetchAllMetrics() {
  const weeks = getWeekRanges(12);
  const backlogData = await getCurrentBacklog();
  const currentBacklog = backlogData.total;

  // Snapshot date in Pacific Time
  const baselineDate = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'long', day: 'numeric', year: 'numeric',
  });

  // Fetch all week reports in parallel
  const weeklyMetrics = await Promise.all(
    weeks.map(async (week) => {
      const report = await getWeekReport(week.startStr, week.endStr);
      return {
        label: week.label,
        startStr: week.startStr,
        endStr: week.endStr,
        opened: report.opened,
        closed: report.closed,
        resolutionTime: report.resolutionTime,
        firstResponseTime: report.firstResponseTime,
        resolvedOnFirstReplyPct: report.resolvedOnFirstReplyPct,
      };
    })
  );

  // Reconstruct backlog per week working backwards from current live count
  let runningBacklog = currentBacklog;
  for (let i = weeklyMetrics.length - 1; i >= 0; i--) {
    weeklyMetrics[i].backlog = Math.max(0, runningBacklog);
    runningBacklog = runningBacklog + weeklyMetrics[i].opened - weeklyMetrics[i].closed;
    if (runningBacklog < 0) runningBacklog = 0;
  }

  // Baseline = today's actual live backlog count (not reconstructed)
  const baselineBacklog = currentBacklog;

  // Add percentage deltas to each week
  for (let i = 0; i < weeklyMetrics.length; i++) {
    const w = weeklyMetrics[i];
    const prev = i > 0 ? weeklyMetrics[i - 1] : null;
    w.pctVsBaseline = baselineBacklog > 0
      ? Math.round((w.backlog - baselineBacklog) / baselineBacklog * 100)
      : 0;
    w.pctVsPriorWeek = (prev && prev.backlog > 0)
      ? Math.round((w.backlog - prev.backlog) / prev.backlog * 100)
      : null;
  }

  return {
    fetchedAt: new Date().toISOString(),
    currentBacklog,
    backlogBreakdown: backlogData,
    baselineBacklog,
    baselineDate,
    weeks: weeklyMetrics,
  };
}

export async function fetchCurrentWeekSnapshot() {
  const weeks = getWeekRanges(1);
  const week = weeks[0];
  const [backlogData, report] = await Promise.all([
    getCurrentBacklog(),
    getWeekReport(week.startStr, week.endStr),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    week: week.label,
    backlog: backlogData.total,
    opened: report.opened,
    closed: report.closed,
    burnRate: report.closed - report.opened,
    resolutionTime: report.resolutionTime,
    firstResponseTime: report.firstResponseTime,
    resolvedOnFirstReplyPct: report.resolvedOnFirstReplyPct,
  };
}
