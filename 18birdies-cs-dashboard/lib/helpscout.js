// HelpScout API v2 client
// Handles OAuth2 token management and all data fetching

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

async function hsPaginated(path, params = {}, embeddedKey) {
  let page = 1;
  let allItems = [];
  let totalPages = 1;

  do {
    const data = await hsGet(path, { ...params, page, pageSize: 50 });
    const items = data?._embedded?.[embeddedKey] || [];
    allItems = allItems.concat(items);
    totalPages = data?.page?.totalPages || 1;
    page++;
  } while (page <= totalPages);

  return allItems;
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
      start: new Date(weekStart),
      end: new Date(weekEnd),
      startStr: formatDate(weekStart),
      endStr: formatDate(weekEnd),
    });
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  }
  return weeks;
}

// ── METRICS FETCHERS ──────────────────────────────────────────────────────

async function getConversationsForRange(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const params = {
    mailbox: mailboxId,
    createdSince: `${startStr}T00:00:00Z`,
    createdBefore: `${endStr}T23:59:59Z`,
  };
  try {
    return await hsPaginated('/conversations', params, 'conversations');
  } catch (e) {
    console.error(`Error fetching conversations ${startStr}-${endStr}:`, e.message);
    return [];
  }
}

async function getClosedInRange(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const params = {
    mailbox: mailboxId,
    status: 'closed',
    modifiedSince: `${startStr}T00:00:00Z`,
    modifiedBefore: `${endStr}T23:59:59Z`,
  };
  try {
    const items = await hsPaginated('/conversations', params, 'conversations');
    return items.filter(c => {
      if (!c.closedAt) return false;
      const closed = new Date(c.closedAt);
      return closed >= new Date(`${startStr}T00:00:00Z`) && closed <= new Date(`${endStr}T23:59:59Z`);
    });
  } catch (e) {
    console.error('Error fetching closed conversations:', e.message);
    return [];
  }
}

async function getCurrentBacklog() {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  try {
    // Fetch active + pending to get full open ticket count
    const [activeData, pendingData] = await Promise.all([
      hsGet('/conversations', { mailbox: mailboxId, status: 'active', pageSize: 1 }),
      hsGet('/conversations', { mailbox: mailboxId, status: 'pending', pageSize: 1 }),
    ]);
    const active = activeData?.page?.totalElements || 0;
    const pending = pendingData?.page?.totalElements || 0;
    return active + pending;
  } catch (e) {
    console.error('Error fetching backlog:', e.message);
    return 0;
  }
}

async function getAvgResolutionTime(closedConversations) {
  const times = closedConversations
    .filter(c => c.closedAt && c.createdAt)
    .map(c => (new Date(c.closedAt) - new Date(c.createdAt)) / (1000 * 60 * 60));
  if (!times.length) return null;
  return times.reduce((a, b) => a + b, 0) / times.length;
}

function groupByTag(conversations) {
  const counts = {};
  conversations.forEach(c => {
    const tags = c.tags?.length ? c.tags : [{ tag: 'untagged' }];
    tags.forEach(t => {
      const name = t.tag || t.name || 'untagged';
      counts[name] = (counts[name] || 0) + 1;
    });
  });
  return counts;
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────

export async function fetchAllMetrics() {
  const weeks = getWeekRanges(12);
  const currentBacklog = await getCurrentBacklog();

  const weeklyMetrics = await Promise.all(
    weeks.map(async (week) => {
      const [opened, closed] = await Promise.all([
        getConversationsForRange(week.startStr, week.endStr),
        getClosedInRange(week.startStr, week.endStr),
      ]);
      const resolutionTime = await getAvgResolutionTime(closed);
      const buckets = groupByTag([...opened, ...closed]);
      return {
        label: week.label,
        startStr: week.startStr,
        endStr: week.endStr,
        opened: opened.length,
        closed: closed.length,
        resolutionTime: resolutionTime ? Math.round(resolutionTime * 10) / 10 : null,
        closedPerAgent: closed.length,
        buckets,
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

  // Baseline = backlog at the earliest week (starting point)
  const baselineBacklog = weeklyMetrics[0].backlog;

  // Add percentage deltas to each week
  for (let i = 0; i < weeklyMetrics.length; i++) {
    const w = weeklyMetrics[i];
    const prev = i > 0 ? weeklyMetrics[i - 1] : null;

    // % change vs baseline (first week)
    w.pctVsBaseline = baselineBacklog > 0
      ? Math.round((w.backlog - baselineBacklog) / baselineBacklog * 100)
      : 0;

    // % change vs prior week
    w.pctVsPriorWeek = (prev && prev.backlog > 0)
      ? Math.round((w.backlog - prev.backlog) / prev.backlog * 100)
      : null;
  }

  return {
    fetchedAt: new Date().toISOString(),
    currentBacklog,
    baselineBacklog,
    weeks: weeklyMetrics,
  };
}

export async function fetchCurrentWeekSnapshot() {
  const weeks = getWeekRanges(1);
  const week = weeks[0];
  const backlog = await getCurrentBacklog();

  const [opened, closed] = await Promise.all([
    getConversationsForRange(week.startStr, week.endStr),
    getClosedInRange(week.startStr, week.endStr),
  ]);

  const resolutionTime = await getAvgResolutionTime(closed);

  return {
    fetchedAt: new Date().toISOString(),
    week: week.label,
    backlog,
    opened: opened.length,
    closed: closed.length,
    burnRate: closed.length - opened.length,
    resolutionTime: resolutionTime ? Math.round(resolutionTime * 10) / 10 : null,
    buckets: groupByTag([...opened, ...closed]),
  };
}
