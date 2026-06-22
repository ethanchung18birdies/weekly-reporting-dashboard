// HelpScout API v2 client
// Uses Reports API for weekly metrics + Conversations API for live backlog

const HELPSCOUT_API = 'https://api.helpscout.net/v2';
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';

let _tokenCache = null;
let _tagIdCache = null;
let _ticketAssigneeCache = null;
const _assigneeWeekCache = new Map();
const _assigneeSubcategoryCache = new Map();
const REPORT_TAG_CONCURRENCY = 4;
const TICKET_THREAD_CONCURRENCY = Number(process.env.TICKET_THREAD_CONCURRENCY || 2);
const TICKET_THREAD_DELAY_MS = Number(process.env.TICKET_THREAD_DELAY_MS || 125);
const HELPSCOUT_RETRY_ATTEMPTS = Number(process.env.HELPSCOUT_RETRY_ATTEMPTS || 6);
const HELPSCOUT_429_FALLBACK_MS = Number(process.env.HELPSCOUT_429_FALLBACK_MS || 65_000);
export const TICKET_SEARCH_LIMIT = Number(process.env.TICKET_SEARCH_LIMIT || 250);
let _nextTicketThreadRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function parseHelpScoutErrorBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function bodyRetryAfterMs(error) {
  const body = error?.bodyJson;
  if (!body) return null;
  const retryAfter = Number(body.retry_after);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  if (Number(error?.status) === 429) {
    const interval = String(body.interval || '').toLowerCase();
    if (interval === 'second') return 1_000;
    if (interval === 'minute') return HELPSCOUT_429_FALLBACK_MS;
    if (interval === 'hour') return 60 * 60 * 1000;
    return HELPSCOUT_429_FALLBACK_MS;
  }

  return null;
}

function retryDelayMs(error, attempt) {
  const retryAfterMs = parseRetryAfterMs(error?.retryAfter);
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 30_000);
  const bodyDelayMs = bodyRetryAfterMs(error);
  if (bodyDelayMs !== null) return bodyDelayMs;
  const exponential = Math.min(30_000, 500 * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 250);
  return exponential + jitter;
}

function shouldRetryHelpScoutError(error) {
  return [408, 429, 500, 502, 503, 504].includes(Number(error?.status));
}

async function waitForTicketThreadSlot() {
  if (TICKET_THREAD_DELAY_MS <= 0) return;
  const now = Date.now();
  const waitMs = Math.max(0, _nextTicketThreadRequestAt - now);
  _nextTicketThreadRequestAt = Math.max(now, _nextTicketThreadRequestAt) + TICKET_THREAD_DELAY_MS;
  if (waitMs > 0) await sleep(waitMs);
}

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
    const body = await res.text();
    const error = new Error(`HelpScout API error ${res.status} for ${path}: ${body}`);
    error.status = res.status;
    error.path = path;
    error.retryAfter = res.headers.get('retry-after');
    error.body = body;
    error.bodyJson = parseHelpScoutErrorBody(body);
    throw error;
  }

  return res.json();
}

async function hsGetWithRetry(path, params = {}, attempts = HELPSCOUT_RETRY_ATTEMPTS, onRetry = null) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await hsGet(path, params);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      if (!shouldRetryHelpScoutError(error)) break;
      const waitMs = retryDelayMs(error, attempt);
      if (onRetry) {
        onRetry({
          phase: 'rate_limit_waiting',
          path,
          status: error.status,
          attempt,
          attempts,
          waitMs,
          message: error?.bodyJson?.message || error.message,
        });
      }
      await sleep(waitMs);
    }
  }

  if (lastError) lastError.attempts = attempts;
  throw lastError;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

function buildEmailReportParams(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  return {
    start: `${startStr}T00:00:00Z`,
    end: `${endStr}T23:59:59Z`,
    // Keep both keys for compatibility across HelpScout report endpoints.
    mailbox: mailboxId,
    mailboxes: mailboxId,
  };
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

const CATEGORY_BY_SUBCATEGORY = new Map([
  ['App Crash/Feature Break Fix', 'Unresolved Bugs'],
  ['Course Profile Info', 'Course Data'],
  ['Scorecard Data', 'Course Data'],
  ['Course Setup', 'Course Data'],
  ['GPS Data Incorrect', 'Course Data'],
  ['Facility Missing', 'Course Data'],
  ['Course Layout Missing', 'Course Data'],
  ['Course Closed', 'Course Data'],
  ['More Course Info Needed', 'Course Data'],
  ['Apple Watch', 'Watch'],
  ['Account Recovery', 'Account'],
  ['Account Setup & Deletion', 'Account'],
  ['Cancel Premium', 'Billing'],
  ['Subscription Access Error', 'Billing'],
  ['Refund Premium', 'Billing'],
  ['Core Round Functionality', 'Usability'],
  ['Scoring - Classic', 'Usability'],
  ['Scoring - Smart Tracking', 'Usability'],
  ['Scoring - Team Modes', 'Usability'],
  ['Tournaments', 'Tournaments'],
  ['Swing Analysis', 'Golf School'],
  ['Friend Requests', 'Community'],
  ['Side Games', 'Community'],
  ['Feed & Sharing', 'Community'],
  ['Device Compatibility', 'Usability'],
  ['Drills', 'Golf School'],
  ['Notifications', 'Messaging'],
  ['Newsletter Unsub', 'Messaging'],
  ['Android Watch', 'Watch'],
  ['Handicap Calculation', 'Stats'],
  ['Golf Bag & Club Management', 'Stats'],
  ['Missing Golf Clubs for Bag Management', 'Stats'],
  ['Watch Features', 'Watch'],
  ['Shot Tracking', 'Feature Request'],
  ['Advanced Stats', 'Feature Request'],
  ['Community', 'Feature Request'],
  ['Betting/Games', 'Feature Request'],
  ['Content & Educational', 'Feature Request'],
  ['Other Feature Requests', 'Feature Request'],
  ['UI / UX Improvements', 'Feature Request'],
  ['Third Party Integrations', 'Feature Request'],
  ['Partnership Requests', 'Partnerships'],
  ['Too Complicated', 'Usability'],
  ['Ad Experience', 'Usability'],
  ['Other', 'Other'],
  ['Compliments', 'Non-actionable Feedback'],
  ['Non-actionable Feedback', 'Non-actionable Feedback'],
  ['Spam', 'Spam'],
]);

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

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function getTagNames(conversation) {
  const embeddedTags = conversation?._embedded?.tags;
  const directTags = conversation?.tags;
  const source = Array.isArray(embeddedTags) ? embeddedTags : Array.isArray(directTags) ? directTags : [];

  return source
    .map((tag) => {
      if (typeof tag === 'string') return tag;
      return tag?.name || tag?.tag || '';
    })
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

async function listConversationsCreatedInRange(startStr, endStr) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T23:59:59Z`);
  const results = [];

  let page = 1;
  let totalPages = 1;
  let shouldStop = false;

  do {
    const data = await hsGet('/conversations', {
      mailbox: mailboxId,
      status: 'all',
      page,
      pageSize: 100,
      sortField: 'createdAt',
      sortOrder: 'desc',
    }).catch(() => null);

    const conversations = data?._embedded?.conversations || [];
    totalPages = data?.page?.totalPages || 1;

    for (const conversation of conversations) {
      const createdAtRaw =
        conversation?.createdAt ||
        conversation?.createdAtUtc ||
        conversation?.createdAtUTC ||
        conversation?.createdAtDate;

      if (!createdAtRaw) continue;

      const createdAt = new Date(createdAtRaw);
      if (Number.isNaN(createdAt.getTime())) continue;

      if (createdAt < start) {
        shouldStop = true;
        break;
      }

      if (createdAt <= end) {
        results.push(conversation);
      }
    }

    page += 1;
  } while (!shouldStop && page <= totalPages);

  return results;
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

function sortCountBreakdown(items, total) {
  const taggedTotal = items.reduce((sum, item) => sum + (item.count || 0), 0);
  const notTagged = Math.max(0, total - taggedTotal);

  return [
    ...items.map((item) => ({
      name: item.name,
      count: item.count || 0,
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

  const results = await mapWithConcurrency(
    resolvedConfig,
    REPORT_TAG_CONCURRENCY,
    async (item) => {
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

      const report = await hsGetWithRetry('/reports/email', {
        ...baseParams,
        tags: String(item.tagId),
      });

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
    }
  );

  return results;
}

async function fetchTaggedIncomingMetrics(baseParams, config) {
  const resolvedConfig = await resolveTagConfig(config);

  const results = await mapWithConcurrency(
    resolvedConfig,
    REPORT_TAG_CONCURRENCY,
    async (item) => {
      if (!item.tagId) {
        return {
          name: item.name,
          hsName: item.hsName,
          tagId: null,
          count: 0,
        };
      }

      const report = await hsGetWithRetry('/reports/email', {
        ...baseParams,
        tags: String(item.tagId),
      });

      return {
        name: item.name,
        hsName: item.hsName,
        tagId: item.tagId,
        count: report?.current?.volume?.emailConversations ?? 0,
      };
    }
  );

  return results;
}

function buildIncomingCategoryBreakdown(categoryMetrics, subcategoryMetrics, totalOpened) {
  const mappedSubcategoryTotals = new Map();

  for (const item of subcategoryMetrics) {
    const mappedCategory = CATEGORY_BY_SUBCATEGORY.get(item.name);
    if (!mappedCategory) continue;

    mappedSubcategoryTotals.set(
      mappedCategory,
      (mappedSubcategoryTotals.get(mappedCategory) || 0) + (item.count || 0)
    );
  }

  const items = categoryMetrics.map((item) => ({
    name: item.name,
    count: Math.max(item.count || 0, mappedSubcategoryTotals.get(item.name) || 0),
  }));

  return sortCountBreakdown(items, totalOpened);
}

// Fast report — overall metrics only, no per-tag breakdown
async function getWeekReport(startStr, endStr) {
  const params = buildEmailReportParams(startStr, endStr);

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

export async function fetchWeekBuckets(startStr, endStr, scope = 'all') {
  const baseParams = buildEmailReportParams(startStr, endStr);

  try {
    const emailReport = await hsGetWithRetry('/reports/email', baseParams);
    const opened = emailReport?.current?.volume?.emailConversations ?? 0;
    const resolved = emailReport?.current?.resolutions?.resolved ?? 0;
    const closed = emailReport?.current?.resolutions?.closed ?? 0;
    const noReply = Math.max(0, closed - resolved);

    const [incomingCategoryMetrics, incomingSubcategoryMetrics] = await Promise.all([
      fetchTaggedIncomingMetrics(baseParams, CATEGORY_TAGS),
      fetchTaggedIncomingMetrics(baseParams, SUBCATEGORY_TAGS),
    ]);

    if (scope === 'incoming') {
      return {
        closed: {
          category: { withReply: [], noReply: [], both: [] },
          subcategory: { withReply: [], noReply: [], both: [] },
        },
        incoming: {
          category: buildIncomingCategoryBreakdown(
            incomingCategoryMetrics,
            incomingSubcategoryMetrics,
            opened
          ),
          subcategory: sortCountBreakdown(incomingSubcategoryMetrics, opened),
        },
      };
    }

    const [closedCategoryMetrics, closedSubcategoryMetrics] = await Promise.all([
      fetchTaggedClosureMetrics(baseParams, CATEGORY_TAGS),
      fetchTaggedClosureMetrics(baseParams, SUBCATEGORY_TAGS),
    ]);

    return {
      closed: {
        category: {
          withReply: sortMetricBreakdown(closedCategoryMetrics, resolved, 'withReply'),
          noReply: sortMetricBreakdown(closedCategoryMetrics, noReply, 'noReply'),
          both: sortMetricBreakdown(closedCategoryMetrics, closed, 'both'),
        },
        subcategory: {
          withReply: sortMetricBreakdown(closedSubcategoryMetrics, resolved, 'withReply'),
          noReply: sortMetricBreakdown(closedSubcategoryMetrics, noReply, 'noReply'),
          both: sortMetricBreakdown(closedSubcategoryMetrics, closed, 'both'),
        },
      },
      incoming: {
        category: buildIncomingCategoryBreakdown(
          incomingCategoryMetrics,
          incomingSubcategoryMetrics,
          opened
        ),
        subcategory: sortCountBreakdown(incomingSubcategoryMetrics, opened),
      },
    };
  } catch (e) {
    console.error(`Error fetching buckets ${startStr}-${endStr}:`, e.message);
    throw e;
  }
}


async function getCurrentBacklog() {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  try {
    const fetchStatusCount = async (status) => {
      const data = await hsGetWithRetry('/conversations', {
        mailbox: mailboxId,
        status,
        pageSize: 1,
      });
      const total = data?.page?.totalElements;
      return Number.isFinite(Number(total)) ? Number(total) : 0;
    };

    const active = await fetchStatusCount('active');

    return { total: active, active, pending: null };
  } catch (e) {
    console.error('Error fetching backlog:', e.message);
    return { total: null, active: null, pending: null };
  }
}

// ── TICKET EXPLORER / EXPORT ─────────────────────────────────────────────

function toIsoStart(dateStr) {
  return `${String(dateStr || '').slice(0, 10)}T00:00:00Z`;
}

function toIsoEnd(dateStr) {
  return `${String(dateStr || '').slice(0, 10)}T23:59:59Z`;
}

function isValidDateStr(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeStringList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim());

  return [...new Set(raw
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== 'all'))];
}

function normalizeTicketFilters(input = {}) {
  const noDateLimit = input.noDateLimit === true || input.noDateLimit === 'true';
  const start = String(input.start || '').slice(0, 10);
  const end = String(input.end || '').slice(0, 10);

  if (!noDateLimit && (!isValidDateStr(start) || !isValidDateStr(end))) {
    throw new Error('Ticket search requires valid start and end dates.');
  }

  if (!noDateLimit && new Date(toIsoStart(start)) > new Date(toIsoEnd(end))) {
    throw new Error('Ticket search start date must be before end date.');
  }

  const assigneeIds = Array.isArray(input.assigneeIds)
    ? input.assigneeIds
    : String(input.assigneeIds || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    start,
    end,
    noDateLimit,
    status: ['active', 'all', 'closed', 'open', 'pending', 'spam'].includes(input.status)
      ? input.status
      : 'all',
    assigneeIds: [...new Set(assigneeIds.map((id) => Number(id)).filter(Number.isFinite))],
    categories: normalizeStringList(input.categories || input.category),
    subcategories: normalizeStringList(input.subcategories || input.subcategory),
    query: String(input.query || '').trim(),
  };
}

function escapeTicketQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();
}

function buildTagClause(names, tagConfigs) {
  const tagNames = names
    .map((name) => tagConfigs.find((item) => item.name === name)?.hsName)
    .filter(Boolean)
    .map((tag) => `tag:"${escapeTicketQueryValue(tag)}"`);

  if (!tagNames.length) return '';
  return tagNames.length === 1 ? tagNames[0] : `(${tagNames.join(' OR ')})`;
}

function tokenizeTicketQuery(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[()"]/g, '').trim())
    .filter(Boolean);
}

function buildTextSearchClause(query) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return '';

  const explicitlyQuoted = /^".+"$/.test(rawQuery);
  if (explicitlyQuoted) {
    const phrase = escapeTicketQueryValue(rawQuery.slice(1, -1));
    return `(body:"${phrase}" OR subject:"${phrase}")`;
  }

  const tokens = tokenizeTicketQuery(rawQuery);
  if (!tokens.length) return '';

  const fieldQuery = tokens.map(escapeTicketQueryValue).join(' ');
  return `(body:(${fieldQuery}) OR subject:(${fieldQuery}))`;
}

function buildTicketAdvancedQuery(filters) {
  const clauses = [];

  if (!filters.noDateLimit) {
    clauses.push(`createdAt:[${toIsoStart(filters.start)} TO ${toIsoEnd(filters.end)}]`);
  }

  const textClause = buildTextSearchClause(filters.query);
  if (textClause) clauses.push(textClause);

  const categoryClause = buildTagClause(filters.categories, CATEGORY_TAGS);
  if (categoryClause) clauses.push(categoryClause);

  const subcategoryClause = buildTagClause(filters.subcategories, SUBCATEGORY_TAGS);
  if (subcategoryClause) clauses.push(subcategoryClause);

  return clauses.length ? `(${clauses.join(' AND ')})` : '';
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function stripHelpScoutHtml(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/\r/g, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p\s*>/gi, '\n\n');
  text = text.replace(/<\/div\s*>/gi, '\n');
  text = text.replace(/<\/li\s*>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractFeedbackSection(text) {
  const match = String(text || '').match(/feedback:\s*([\s\S]*)/i);
  if (!match) return '';
  return cleanText(
    match[1].split(/\n+\s*(technical information|site information|beacon visitor activity|beacon history)\b/i)[0]
  );
}

function stripMessageHeaders(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim());
  let splitAt = 0;

  for (let idx = 0; idx < Math.min(lines.length, 8); idx += 1) {
    if (lines[idx]) continue;
    const headerBlock = lines.slice(0, idx).filter(Boolean);
    const headerText = headerBlock.join('\n').toLowerCase();
    if (
      headerBlock.length &&
      (
        headerText.includes('from') ||
        headerBlock.some((line) => line.includes('@')) ||
        headerBlock.some((line) => /^[A-Z][a-z]+ \d{1,2}, \d{1,2}:\d{2}\s*(am|pm)$/i.test(line))
      )
    ) {
      splitAt = idx + 1;
    }
    break;
  }

  return cleanText(lines.slice(splitAt).join('\n'));
}

function stripBeaconMetadata(text) {
  const lowered = String(text || '').toLowerCase();
  const beaconMarkers = [
    'beacon visitor activity',
    'technical information',
    'site information',
    'beacon history',
    'beacon id:',
  ];

  if (!beaconMarkers.some((marker) => lowered.includes(marker))) return text;

  const lines = String(text || '').split('\n').map((line) => line.trim());
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].toLowerCase() !== 'from') continue;
    const emailLine = lines[idx + 1] || '';
    if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(emailLine)) continue;

    let start = Math.max(idx - 2, 0);
    while (start > 0 && lines[start - 1]) start -= 1;
    const candidate = lines.slice(start).join('\n').trim();
    if (candidate) return candidate;
  }

  const feedbackMatch = String(text || '').match(/(feedback:\s*[\s\S]+)$/i);
  return feedbackMatch ? feedbackMatch[1].trim() : text;
}

function isLowSignalTechnicalDump(text) {
  const lowered = String(text || '').toLowerCase();
  const markers = [
    'technical information',
    'site information',
    'beacon history',
    'beacon opened on',
    'beacon id:',
    'current page:',
    'ip address:',
    'browser/version:',
    'authentication mode:',
  ];
  const markerHits = markers.filter((marker) => lowered.includes(marker)).length;
  if (markerHits < 3) return false;

  const textWithoutUrls = lowered.replace(/https?:\/\/\S+/g, ' ');
  const colonLines = textWithoutUrls.split('\n').filter((line) => line.includes(':')).length;
  const hasHumanSignal = /\b(i|i'm|i’ve|my|me|can i|how do i|why|please)\b/.test(textWithoutUrls) ||
    textWithoutUrls.includes('?');
  return colonLines >= 5 && !hasHumanSignal;
}

function threadText(thread) {
  for (const key of ['body', 'bodyPreview', 'plaintext']) {
    let text = stripHelpScoutHtml(thread?.[key]);
    if (!text) continue;
    text = stripBeaconMetadata(text);
    text = stripMessageHeaders(text);
    if (text) return text;
  }
  return '';
}

function threadPriority(thread, text) {
  const createdByType = String(thread?.createdBy?.type || '').toLowerCase();
  const threadType = String(thread?.type || '').toLowerCase();
  const hasFeedbackSection = extractFeedbackSection(text) ? 1 : 0;
  const isCustomer = createdByType === 'customer' ? 1 : 0;
  const isCustomerMessage = ['customer', 'message'].includes(threadType) ? 1 : 0;
  return [hasFeedbackSection, isCustomer + isCustomerMessage, text.length];
}

export function extractCustomerMessageFromThreads(threads = []) {
  const candidates = [];

  for (const thread of threads) {
    const text = threadText(thread);
    if (!text) continue;

    const createdByType = String(thread?.createdBy?.type || '').toLowerCase();
    const threadType = String(thread?.type || '').toLowerCase();
    const looksCustomerAuthored =
      createdByType === 'customer' ||
      ['customer', 'message'].includes(threadType) ||
      extractFeedbackSection(text);

    if (!looksCustomerAuthored) continue;

    const selectedText = extractFeedbackSection(text) || text;
    if (!selectedText || isLowSignalTechnicalDump(selectedText)) continue;
    candidates.push({ priority: threadPriority(thread, text), text: selectedText });
  }

  if (!candidates.length) return '';

  candidates.sort((a, b) => {
    for (let idx = 0; idx < a.priority.length; idx += 1) {
      if (b.priority[idx] !== a.priority[idx]) return b.priority[idx] - a.priority[idx];
    }
    return 0;
  });

  return cleanText(candidates[0].text);
}

function conversationWebUrl(conversation) {
  return conversation?._links?.web?.href || (
    conversation?.number
      ? `https://secure.helpscout.net/conversation/${conversation.number}`
      : ''
  );
}

function assigneeName(assignee) {
  if (!assignee) return '';
  const firstLast = [assignee.first, assignee.last].filter(Boolean).join(' ').trim();
  return assignee.name || firstLast || assignee.email || '';
}

function baseTicketRow(conversation) {
  const tags = getTagNames(conversation);
  const customer = conversation?.primaryCustomer || {};
  const assignee = conversation?.assignee || {};

  return {
    ticket_id: conversation?.id || '',
    conversation_number: conversation?.number || '',
    helpscout_url: conversationWebUrl(conversation),
    feedback: '',
    date_submitted: conversation?.createdAt || '',
    subject: cleanText(conversation?.subject || ''),
    status: conversation?.status || '',
    assignee: assigneeName(assignee),
    assignee_id: assignee?.id || '',
    tags: tags.join(', '),
    customer_name: [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim(),
    customer_email: customer.email || '',
    preview: cleanText(conversation?.preview || ''),
    thread_count: '',
    updated_at: conversation?.modifiedAt || conversation?.updatedAt || '',
    export_status: 'OK',
    status_note: '',
  };
}

export function ticketConversationToSeed(conversation) {
  return baseTicketRow(conversation);
}

function rowMatchesQuery(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [
    row.subject,
    row.preview,
    row.tags,
    row.feedback,
    row.customer_email,
    row.customer_name,
    row.conversation_number,
  ].some((value) => String(value || '').toLowerCase().includes(q));
}

async function listAllUsers() {
  if (_ticketAssigneeCache && _ticketAssigneeCache.expiresAt > Date.now()) {
    return _ticketAssigneeCache.data;
  }

  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const users = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await hsGetWithRetry('/users', {
      mailbox: mailboxId,
      page,
      pageSize: 100,
    }).catch(() => null);

    const pageUsers = data?._embedded?.users || [];
    for (const user of pageUsers) {
      const firstLast = [user.firstName || user.first, user.lastName || user.last].filter(Boolean).join(' ').trim();
      const name = user.name || firstLast || user.email || `User ${user.id}`;
      if (user?.id) {
        users.push({
          id: user.id,
          name,
          email: user.email || '',
          type: user.type || '',
        });
      }
    }

    totalPages = data?.page?.totalPages || 1;
    page += 1;
  } while (page <= totalPages);

  const deduped = Array.from(new Map(users.map((user) => [String(user.id), user])).values())
    .sort((a, b) => a.name.localeCompare(b.name));

  _ticketAssigneeCache = {
    data: deduped,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  };

  return deduped;
}

export async function fetchTicketAssignees() {
  return listAllUsers();
}

export function getTicketFilterOptions() {
  return {
    categories: CATEGORY_TAGS.map((item) => item.name),
    subcategories: SUBCATEGORY_TAGS.map((item) => ({
      name: item.name,
      category: CATEGORY_BY_SUBCATEGORY.get(item.name) || '',
    })),
  };
}

async function listConversationsForAssignee(filters, assigneeId, maxRows, onProgress) {
  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const advancedQuery = buildTicketAdvancedQuery(filters);
  const rows = [];

  let page = 1;
  let totalPages = 1;
  let shouldStop = false;

  do {
    const params = {
      mailbox: mailboxId,
      status: filters.status,
      assigned_to: assigneeId || undefined,
      query: advancedQuery || undefined,
      page,
      pageSize: 100,
      sortField: 'createdAt',
      sortOrder: 'desc',
    };

    const data = await hsGetWithRetry('/conversations', params, HELPSCOUT_RETRY_ATTEMPTS, onProgress);
    const conversations = data?._embedded?.conversations || [];
    totalPages = data?.page?.totalPages || 1;

    for (const conversation of conversations) {
      rows.push(conversation);
      if (maxRows !== null && rows.length >= maxRows) {
        shouldStop = true;
        break;
      }
    }

    if (onProgress) {
      onProgress({
        phase: 'indexing',
        page,
        totalPages,
        indexed: rows.length,
        assigneeId: assigneeId || 'all',
      });
    }

    page += 1;
  } while (!shouldStop && page <= totalPages);

  return rows;
}

export async function listTicketConversations(rawFilters, options = {}) {
  const filters = normalizeTicketFilters(rawFilters);
  const maxRows = options.maxRows === null
    ? null
    : Number(options.maxRows || TICKET_SEARCH_LIMIT);
  const assignees = filters.assigneeIds.length ? filters.assigneeIds : [null];
  const byId = new Map();
  let capped = false;

  for (const assigneeId of assignees) {
    const remaining = maxRows === null ? null : Math.max(0, maxRows - byId.size + 1);
    if (remaining !== null && remaining <= 0) {
      capped = true;
      break;
    }

    const rows = await listConversationsForAssignee(filters, assigneeId, remaining, options.onProgress);
    for (const row of rows) {
      if (row?.id) byId.set(String(row.id), row);
      if (maxRows !== null && byId.size >= maxRows) {
        capped = true;
        break;
      }
    }
  }

  const conversations = Array.from(byId.values())
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return {
    filters,
    conversations: maxRows === null ? conversations : conversations.slice(0, maxRows),
    capped,
  };
}

async function fetchConversationThreads(conversationId) {
  await waitForTicketThreadSlot();
  const data = await hsGetWithRetry(`/conversations/${conversationId}/threads`, { pageSize: 100 });
  return data?._embedded?.threads || [];
}

function exportErrorSummary(error) {
  const status = error?.status ? `HTTP ${error.status}` : 'Error';
  const attempts = error?.attempts ? ` after ${error.attempts} attempts` : '';
  const path = error?.path ? ` on ${error.path}` : '';
  const message = cleanText(error?.body || error?.message || 'Unknown failure')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
  return `${status}${attempts}${path}${message ? `: ${message}` : ''}`;
}

export async function enrichTicketConversations(conversations, options = {}) {
  const onProgress = options.onProgress;
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  let processed = 0;
  let errors = 0;
  let skipped = 0;

  const rows = await mapWithConcurrency(
    conversations,
    Math.max(1, TICKET_THREAD_CONCURRENCY),
    async (conversation) => {
      const row = baseTicketRow(conversation);
      if (shouldStop()) {
        skipped += 1;
        row.export_status = 'Not processed';
        row.feedback = row.preview || '';
        row.status_note = 'Thread fetch skipped because the export was nearing the server time limit. Narrow filters or rerun this segment for full thread text.';
        processed += 1;
        if (onProgress) {
          onProgress({
            phase: 'fetching_threads',
            processed,
            total: conversations.length,
            errors,
            skipped,
          });
        }
        return row;
      }

      try {
        const threads = await fetchConversationThreads(conversation.id);
        row.feedback = extractCustomerMessageFromThreads(threads);
        row.thread_count = threads.length;
        row.export_status = 'OK';
      } catch (error) {
        errors += 1;
        row.export_status = 'Thread fetch failed';
        row.feedback = row.preview || '';
        row.status_note = `Thread fetch failed: ${exportErrorSummary(error)}`;
      } finally {
        processed += 1;
        if (onProgress) {
          onProgress({
            phase: 'fetching_threads',
            processed,
            total: conversations.length,
            errors,
            skipped,
          });
        }
      }
      return row;
    }
  );

  return {
    rows: options.applyLocalQueryFilter
      ? rows.filter((row) => rowMatchesQuery(row, options.query))
      : rows,
    errors,
    skipped,
  };
}

export async function enrichTicketSeedRows(seedRows, options = {}) {
  const onProgress = options.onProgress;
  let processed = 0;
  let errors = 0;

  const rows = await mapWithConcurrency(
    seedRows,
    Math.max(1, TICKET_THREAD_CONCURRENCY),
    async (seedRow) => {
      const row = { ...seedRow };
      try {
        const threads = await fetchConversationThreads(row.ticket_id);
        row.feedback = extractCustomerMessageFromThreads(threads);
        row.thread_count = threads.length;
        row.export_status = 'OK';
        row.status_note = '';
      } catch (error) {
        errors += 1;
        row.export_status = 'Thread fetch failed';
        row.feedback = row.preview || '';
        row.status_note = `Thread fetch failed: ${exportErrorSummary(error)}`;
      } finally {
        processed += 1;
        if (onProgress) {
          onProgress({
            phase: 'fetching_threads',
            processed,
            total: seedRows.length,
            errors,
          });
        }
      }
      return row;
    }
  );

  return { rows, errors };
}

export function ticketRowsToSheet(rows, columns) {
  const selectedColumns = Array.isArray(columns) && columns.length
    ? columns
    : DEFAULT_TICKET_COLUMNS.map((column) => column.key);
  const columnConfigByKey = new Map(ALL_TICKET_COLUMNS.map((column) => [column.key, column]));
  const safeColumns = selectedColumns.filter((key) => columnConfigByKey.has(key));
  const finalColumns = safeColumns.length ? safeColumns : DEFAULT_TICKET_COLUMNS.map((column) => column.key);

  const header = finalColumns.map((key) => columnConfigByKey.get(key)?.label || key);
  const body = rows.map((row) => finalColumns.map((key) => row[key] ?? ''));
  return [header, ...body];
}

export const DEFAULT_TICKET_COLUMNS = [
  { key: 'ticket_id', label: 'Ticket ID' },
  { key: 'helpscout_url', label: 'Help Scout URL' },
  { key: 'feedback', label: 'Customer Message' },
  { key: 'date_submitted', label: 'Date Submitted' },
  { key: 'subject', label: 'Subject' },
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'tags', label: 'Tags' },
  { key: 'export_status', label: 'Export Status' },
  { key: 'status_note', label: 'Status Note' },
];

export const ALL_TICKET_COLUMNS = [
  ...DEFAULT_TICKET_COLUMNS,
  { key: 'conversation_number', label: 'Conversation Number' },
  { key: 'customer_name', label: 'Customer Name' },
  { key: 'customer_email', label: 'Customer Email' },
  { key: 'preview', label: 'Preview' },
  { key: 'thread_count', label: 'Thread Count' },
  { key: 'updated_at', label: 'Updated At' },
].filter((column, index, columns) => columns.findIndex((item) => item.key === column.key) === index);

// ── MAIN EXPORT ───────────────────────────────────────────────────────────

export async function fetchAllMetrics() {
  const weeks = getWeekRanges(12);
  const backlogData = await getCurrentBacklog();
  const currentBacklog = backlogData.total;

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

  return {
    fetchedAt: new Date().toISOString(),
    currentBacklog,
    backlogBreakdown: backlogData,
    weeks: weeklyMetrics,
  };
}

export async function fetchWeekAssignees(startStr, endStr) {
  const cacheKey = `${startStr}_${endStr}`;
  const cached = _assigneeWeekCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;

  const ASSIGNEES = [
    { id: 905541, name: 'Jane Matienzo' },
    { id: 905525, name: 'Jhird Verano' },
    { id: 905514, name: 'Baetiong John' },
    { id: 905526, name: 'John Espuerta' },
    { id: 905521, name: 'Marianne Figueroa' },
    { id: 938176, name: 'Jerlene Geliang' },
    { id: 905515, name: 'Nico Delos Reyes' },
    { id: 905523, name: 'Rendell Severino' },
    { id: 905524, name: 'Mary Shen' },
    { id: 865188, name: 'Ben Atienza' },
    { id: 905876, name: 'Cjay Baetiong' },
    { id: 906539, name: 'Czarina Cruz' },
    { id: 865187, name: 'Jennifer Moron' },
    { id: 905518, name: 'Mickael De Guzman' },
    { id: 929227, name: 'Michael Decena' },
    { id: 929229, name: 'Fernan Gomez' },
    { id: 929231, name: 'Laila Elaine Gelle' },
    { id: 935563, name: 'Juan Caluma' },
    { id: 929233, name: 'Vincent Joel Santos' },
    { id: 929234, name: 'Margie Ativo' },
  ];

  try {
    const results = await Promise.all(
      ASSIGNEES.map(async ({ id, name }) => {
        const report = await hsGet('/reports/user', {
          user: id,
          start: `${startStr}T00:00:00Z`,
          end: `${endStr}T23:59:59Z`,
          mailboxes: mailboxId,
          types: 'email',
        }).catch(() => null);

        return {
          id,
          name,
          count: report?.current?.closed ?? 0,
        };
      })
    );

    const result = results.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    _assigneeWeekCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    return result;
  } catch (e) {
    console.error(`Error fetching assignee breakdown ${startStr}-${endStr}:`, e.message);
    throw e;
  }
}

export async function fetchAssigneeSubcategories(startStr, endStr, assignee = 'all') {
  const cacheKey = `${startStr}_${endStr}_${assignee}`;
  const cached = _assigneeSubcategoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const mailboxId = process.env.HELPSCOUT_MAILBOX_ID;
  const baseStart = `${startStr}T00:00:00Z`;
  const baseEnd = `${endStr}T23:59:59Z`;

  const resolvedConfig = await resolveTagConfig(SUBCATEGORY_TAGS);

  const assigneeId =
    assignee && assignee !== 'all' ? Number(assignee) : null;

  const totalClosedReport = assigneeId
    ? await hsGet('/reports/user', {
        user: assigneeId,
        start: baseStart,
        end: baseEnd,
        mailboxes: mailboxId,
        types: 'email',
      }).catch(() => null)
    : await hsGet('/reports/email', buildEmailReportParams(startStr, endStr)).catch(() => null);

  const totalClosed = assigneeId
    ? totalClosedReport?.current?.closed ?? 0
    : totalClosedReport?.current?.resolutions?.closed ?? 0;

  const items = await Promise.all(
    resolvedConfig.map(async (item) => {
      if (!item.tagId) {
        return {
          name: item.name,
          count: 0,
          hsName: item.hsName,
          tagId: null,
        };
      }

      const report = assigneeId
        ? await hsGet('/reports/user', {
            user: assigneeId,
            start: baseStart,
            end: baseEnd,
            mailboxes: mailboxId,
            types: 'email',
            tags: String(item.tagId),
          }).catch(() => null)
        : await hsGet('/reports/email', {
            ...buildEmailReportParams(startStr, endStr),
            tags: String(item.tagId),
          }).catch(() => null);

      const count = assigneeId
        ? report?.current?.closed ?? 0
        : report?.current?.resolutions?.closed ?? 0;

      return {
        name: item.name,
        count,
        hsName: item.hsName,
        tagId: item.tagId,
      };
    })
  );

  const taggedTotal = items.reduce((sum, item) => sum + (item.count || 0), 0);
  const notTagged = Math.max(0, totalClosed - taggedTotal);

  const breakdown = [
    ...items.map((item) => ({
      name: item.name,
      count: item.count || 0,
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

  const data = {
    totalClosed,
    subcategories: breakdown,
  };

  _assigneeSubcategoryCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });

  return data;
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
    burnRate: report.totalClosed - report.opened,
    resolutionTime: report.resolutionTime,
    firstResponseTime: report.firstResponseTime,
    resolvedOnFirstReplyPct: report.resolvedOnFirstReplyPct,
    totalClosed: report.totalClosed
  };
}
