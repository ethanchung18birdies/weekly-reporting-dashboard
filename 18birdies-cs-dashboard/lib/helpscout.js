// HelpScout API v2 client
// Uses Reports API for weekly metrics + Conversations API for live backlog

const HELPSCOUT_API = 'https://api.helpscout.net/v2';
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';

let _tokenCache = null;
let _tagIdCache = null;

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
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

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

// ── TAG CONFIG ────────────────────────────────────────────────────────────

const CATEGORY_TAGS = [
  { name: 'Account', hsName: 'category: account' },
  { name: 'Billing', hsName: 'category: billing' },
  { name: 'Community', hsName: 'category: community' },
  { name: 'Course Data', hsName: 'category: course data' },
  { name: 'Feature Request', hsName: 'category: feature request' },
  { name: 'Golf School', hsName: 'category: golf school' },
  { name: 'Messaging', hsName: 'category: messaging' },
  { name: 'Non-actionable Feedback', hsName: 'category: non-actionable feedback' },
  { name: 'Other', hsName: 'category: other' },
  { name: 'Partnerships', hsName: 'category: partnerships' },
  { name: 'Spam', hsName: 'category: spam' },
  { name: 'Stats', hsName: 'category: stats' },
  { name: 'Tournaments', hsName: 'category: tournaments' },
  { name: 'Unresolved Bugs', hsName: 'category: app failure' },
  { name: 'Usability', hsName: 'category: usability' },
  { name: 'Watch', hsName: 'category: watch' },
];

const SUBCATEGORY_TAGS = [
  { name: 'Account Recovery', hsName: 'subcategory: account recovery' },
  { name: 'Account Setup & Deletion', hsName: 'subcategory: account setup & deletion' },
  { name: 'Ad Experience', hsName: 'subcategory: ad experience' },
  { name: 'Advanced Stats', hsName: 'subcategory: advanced stats' },
  { name: 'Android Watch', hsName: 'subcategory: android watch' },
  { name: 'App Crash/Feature Break Fix', hsName: 'subcategory: app crash/feature break fix' },
  { name: 'Apple Watch', hsName: 'subcategory: apple watch' },
  { name: 'Betting/Games', hsName: 'subcategory: betting/games' },
  { name: 'Cancel Premium', hsName: 'subcategory: cancel premium' },
  { name: 'Compliments', hsName: 'subcategory: compliments' },
  { name: 'Community', hsName: 'subcategory: community' },
  { name: 'Content & Educational', hsName: 'subcategory: content & educational' },
  { name: 'Core Round Functionality', hsName: 'subcategory: core round functionality' },
  { name: 'Course Closed', hsName: 'subcategory: course closed' },
  { name: 'Course Layout Missing', hsName: 'subcategory: course layout missing' },
  { name: 'Course Profile Info', hsName: 'subcategory: course profile info' },
  { name: 'Course Setup', hsName: 'subcategory: course setup' },
  { name: 'Device Compatibility', hsName: 'subcategory: device compatibility' },
  { name: 'Drills', hsName: 'subcategory: drills' },
  { name: 'Facility Missing', hsName: 'subcategory: facility missing' },
  { name: 'Feed & Sharing', hsName: 'subcategory: feed & sharing' },
  { name: 'Friend Requests', hsName: 'subcategory: friend requests' },
  { name: 'Golf Bag & Club Management', hsName: 'subcategory: golf bag & club management' },
  { name: 'GPS Data Incorrect', hsName: 'subcategory: gps data incorrect' },
  { name: 'Handicap Calculation', hsName: 'subcategory: handicap calculation' },
  { name: 'Missing Golf Clubs for Bag Management', hsName: 'subcategory: missing golf clubs for bag management' },
  { name: 'More Course Info Needed', hsName: 'subcategory: more course info needed' },
  { name: 'Newsletter Unsub', hsName: 'subcategory: newsletter unsub' },
  { name: 'Non-actionable Feedback', hsName: 'subcategory: non-actionable feedback' },
  { name: 'Notifications', hsName: 'subcategory: notifications' },
  { name: 'Other', hsName: 'subcategory: other' },
  { name: 'Other Feature Requests', hsName: 'subcategory: other feature requests' },
  { name: 'Partnership Requests', hsName: 'subcategory: partnership requests' },
  { name: 'Refund Premium', hsName: 'subcategory: refund premium' },
  { name: 'Scorecard Data', hsName: 'subcategory: scorecard data' },
  { name: 'Scoring - Classic', hsName: 'subcategory: scoring - classic' },
  { name: 'Scoring - Smart Tracking', hsName: 'subcategory: scoring - smart tracking' },
  { name: 'Scoring - Team Modes', hsName: 'subcategory: scoring - team modes' },
  { name: 'Shot Tracking', hsName: 'subcategory: shot tracking' },
  { name: 'Side Games', hsName: 'subcategory: side games' },
  { name: 'Spam', hsName: 'subcategory: spam' },
  { name: 'Subscription Access Error', hsName: 'subcategory: subscription access error' },
  { name: 'Swing Analysis', hsName: 'subcategory: swing analysis' },
  { name: 'Third Party Integrations', hsName: 'subcategory: third party integrations' },
  { name: 'Too Complicated', hsName: 'subcategory: too complicated' },
  { name: 'Tournaments', hsName: 'subcategory: tournaments' },
  { name: 'UI / UX Improvements', hsName: 'subcategory: ui / ux improvements' },
  { name: 'Watch Features', hsName: 'subcategory: watch features' },
];

// ── REPORTS API ───────────────────────────────────────────────────────────

async function listAllTags() {
  if (_tagIdCache) return _tagIdCache;

  const byName = new Map();
  let page = 1;
  let totalPages = 1;

  do {
    const data = await hsGet('/tags', { page }).catch(() => null);
    const tags = data?._embedded?.tags || [];

    for (const tag of tags) {
      if (tag?.name) {
        byName.set(tag.name.trim().toLowerCase(), tag.id);
      }
    }

    totalPages = data?.page?.totalPages || 1;
    page += 1;
  } while (page <= totalPages);

  _tagIdCache = byName;
  return byName;
}

async function resolveTagConfig(config) {
  const tagMap = await listAllTags();
  return config.map((item) => ({
    ...item,
    tagId: tagMap.get(item.hsName.trim().toLowerCase()) ?? null,
  }));
}

function sortMetricBreakdown(items, total, metricKey) {
  const taggedTotal = items.reduce((sum, item) => sum + (item[metricKey] || 0), 0);
  const notTagged = Math.max(0, total - taggedTotal);

  return [
    ...items.map((item) => ({
      name: item.name,
      count: item[metricKey] || 0,
    })),
    { name: 'Not tagged', count: notTagged },
  ]
    .filter((item) => item.count > 0 || item.name === 'Not tagged')
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.name === 'Not tagged') return 1;
      if (b.name === 'Not tagged') return -1;
      return a.name.localeCompare(b.name);
    });
}

async function fetchTaggedClosureMetrics(baseParams, config) {
  const resolvedConfig = await resolveTagConfig(config);

  const results = await Promise.all(
    resolvedConfig.map(async (item) => {
      if (!item.tagId) {
        return {
          name: item.name,
          hsName: item.hsName,
          tagId: null,
          withReply: 0,
          noReply: 0,
          both: 0,
        };
      }

      const report = await hsGet('/reports/email', {
        ...baseParams,
        tags: String(item.tagId),
      }).catch(() => null);

      const resolved = report?.current?.resolutions?.resolved ?? 0;
      const closed = report?.current?.resolutions?.closed ?? 0;

      return {
        name: item.name,
        hsName: item.hsName,
        tagId: item.tagId,
        withReply: resolved,
        noReply: Math.max(0, closed - resolved),
        both: closed,
      };
    })
  );

  return results;
}

// Fast report — overall metrics only, no per-tag breakdown
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

    const opened = current.volume?.emailConversations ?? 0;
    const closed = current.resolutions?.resolved ?? 0;
    const totalClosed = current.resolutions?.closed ?? 0;

    const resolutionTimeSecs = current.resolutions?.resolutionTime ?? null;
    const resolutionTime = resolutionTimeSecs
      ? Math.round((resolutionTimeSecs / 86400) * 10) / 10
      : null;

    const frtSecs = current.responses?.firstResponseTime ?? null;
    const firstResponseTime = frtSecs
      ? Math.round((frtSecs / 3600) * 10) / 10
      : null;

    const resolvedOnFirstReplyPct = current.resolutions?.percentResolvedOnFirstReply ?? null;

    return {
      opened,
      closed,
      totalClosed,
      resolutionTime,
      firstResponseTime,
      resolvedOnFirstReplyPct,
    };
  } catch (e) {
    console.error(`Error fetching week report ${startStr}-${endStr}:`, e.message);
    return {
      opened: 0,
      closed: 0,
      totalClosed: 0,
      resolutionTime: null,
      firstResponseTime: null,
      resolvedOnFirstReplyPct: null,
    };
  }
}

export async function fetchWeekBuckets(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const baseParams = {
    start: `${startStr}T00:00:00Z`,
    end: `${endStr}T23:59:59Z`,
    mailbox: mailboxId,
  };

  try {
    const emailReport = await hsGet('/reports/email', baseParams).catch(() => null);
    const resolved = emailReport?.current?.resolutions?.resolved ?? 0;
    const closed = emailReport?.current?.resolutions?.closed ?? 0;
    const noReply = Math.max(0, closed - resolved);

    const [categoryMetrics, subcategoryMetrics] = await Promise.all([
      fetchTaggedClosureMetrics(baseParams, CATEGORY_TAGS),
      fetchTaggedClosureMetrics(baseParams, SUBCATEGORY_TAGS),
    ]);

    const unresolvedSubcategoryTags = subcategoryMetrics
      .filter(x => !x.tagId)
      .map(x => x.hsName);

    const resolvedSubcategoryTags = subcategoryMetrics
      .filter(x => x.tagId)
      .map(x => ({
        hsName: x.hsName,
        tagId: x.tagId,
        both: x.both,
        withReply: x.withReply,
        noReply: x.noReply,
      }))
      .sort((a, b) => b.both - a.both);

    return {
      category: {
        withReply: sortMetricBreakdown(categoryMetrics, resolved, 'withReply'),
        noReply: sortMetricBreakdown(categoryMetrics, noReply, 'noReply'),
        both: sortMetricBreakdown(categoryMetrics, closed, 'both'),
      },
      subcategory: {
        withReply: sortMetricBreakdown(subcategoryMetrics, resolved, 'withReply'),
        noReply: sortMetricBreakdown(subcategoryMetrics, noReply, 'noReply'),
        both: sortMetricBreakdown(subcategoryMetrics, closed, 'both'),
      },
      debug: {
        unresolvedSubcategoryTags,
        resolvedSubcategoryTags,
      },
    };
  } catch (e) {
    console.error(`Error fetching buckets ${startStr}-${endStr}:`, e.message);
    return {
      category: { withReply: [], noReply: [], both: [] },
      subcategory: { withReply: [], noReply: [], both: [] },
      debug: {
        unresolvedSubcategoryTags: [],
        resolvedSubcategoryTags: [],
      },
    };
  }
}


async function getCurrentBacklog() {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  try {
    const activeData = await hsGet('/conversations', {
      mailbox: mailboxId,
      status: 'active',
      pageSize: 1,
    });
    const active = activeData?.page?.totalElements || 0;
    return { total: active, active, pending: 0 };
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

  const baselineDate = 'March 16, 2026';

  const weeklyMetrics = await Promise.all(
  weeks.map(async (week) => {
    const report = await getWeekReport(week.startStr, week.endStr);
    return {
      label: week.label,
      startStr: week.startStr,
      endStr: week.endStr,
      opened: report.opened,
      closed: report.closed,
      totalClosed: report.totalClosed,
      resolutionTime: report.resolutionTime,
      firstResponseTime: report.firstResponseTime,
      resolvedOnFirstReplyPct: report.resolvedOnFirstReplyPct,
    };
  })
);

  let runningBacklog = currentBacklog;
  for (let i = weeklyMetrics.length - 1; i >= 0; i--) {
    weeklyMetrics[i].backlog = Math.max(0, runningBacklog);
    runningBacklog = runningBacklog + weeklyMetrics[i].opened - weeklyMetrics[i].closed;
    if (runningBacklog < 0) runningBacklog = 0;
  }

  const baselineBacklog = 16431;

  for (let i = 0; i < weeklyMetrics.length; i++) {
    const w = weeklyMetrics[i];
    const prev = i > 0 ? weeklyMetrics[i - 1] : null;

    w.pctVsBaseline = baselineBacklog > 0
      ? Math.round(((w.backlog - baselineBacklog) / baselineBacklog) * 10000) / 100
      : 0;

    w.pctVsPriorWeek = (prev && prev.backlog > 0)
      ? Math.round(((w.backlog - prev.backlog) / prev.backlog) * 10000) / 100
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

export async function fetchWeekAssignees(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const startMs = Date.parse(`${startStr}T00:00:00Z`);
  const endMs = Date.parse(`${endStr}T23:59:59Z`);

  const counts = new Map();
  let page = 1;
  let totalPages = 1;

  try {
    do {
      const data = await hsGet('/conversations', {
        mailbox: mailboxId,
        status: 'closed',
        page,
        pageSize: 100,
        sortField: 'modifiedAt',
        sortOrder: 'desc',
      }).catch(() => null);

      const rows = data?._embedded?.conversations || [];

      for (const convo of rows) {
        const closedAtRaw = convo?.closedAt;
        const closedAtMs = closedAtRaw ? Date.parse(closedAtRaw) : NaN;

        if (!Number.isFinite(closedAtMs)) continue;
        if (closedAtMs < startMs || closedAtMs > endMs) continue;

        const assignee =
          convo?.assignee ||
          convo?.owner ||
          null;

        const assigneeName =
          assignee?.name ||
          [assignee?.firstName, assignee?.lastName].filter(Boolean).join(' ').trim() ||
          [assignee?.first, assignee?.last].filter(Boolean).join(' ').trim() ||
          assignee?.email ||
          'Unassigned';

        counts.set(assigneeName, (counts.get(assigneeName) || 0) + 1);
      }

      totalPages = data?.page?.totalPages || 1;
      page += 1;
    } while (page <= totalPages);

    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } catch (e) {
    console.error(`Error fetching assignee breakdown ${startStr}-${endStr}:`, e.message);
    return [];
  }
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
    totalClosed: report.totalClosed
  };
}
