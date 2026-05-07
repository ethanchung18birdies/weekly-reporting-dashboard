// HelpScout API v2 client
// Uses Reports API for weekly metrics + Conversations API for live backlog

const HELPSCOUT_API = 'https://api.helpscout.net/v2';
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';

let _tokenCache = null;
let _tagIdCache = null;
const _assigneeWeekCache = new Map();
const _assigneeSubcategoryCache = new Map();
const _incomingNotTaggedCache = new Map();

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
      return tag?.name || '';
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

async function fetchTaggedIncomingMetrics(baseParams, config) {
  const resolvedConfig = await resolveTagConfig(config);

  const results = await Promise.all(
    resolvedConfig.map(async (item) => {
      if (!item.tagId) {
        return {
          name: item.name,
          hsName: item.hsName,
          tagId: null,
          count: 0,
        };
      }

      const report = await hsGet('/reports/email', {
        ...baseParams,
        tags: String(item.tagId),
      }).catch(() => null);

      return {
        name: item.name,
        hsName: item.hsName,
        tagId: item.tagId,
        count: report?.current?.volume?.emailConversations ?? 0,
      };
    })
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

function buildIncomingDebug(categoryMetrics, subcategoryMetrics, totalOpened) {
  const mappedCategoryTotals = new Map();

  for (const item of subcategoryMetrics) {
    const mappedCategory = CATEGORY_BY_SUBCATEGORY.get(item.name);
    if (!mappedCategory) continue;

    mappedCategoryTotals.set(
      mappedCategory,
      (mappedCategoryTotals.get(mappedCategory) || 0) + (item.count || 0)
    );
  }

  const categoryComparisons = categoryMetrics
    .map((item) => {
      const directCategoryCount = item.count || 0;
      const mappedSubcategoryCount = mappedCategoryTotals.get(item.name) || 0;
      const usedCount = Math.max(directCategoryCount, mappedSubcategoryCount);

      return {
        name: item.name,
        directCategoryCount,
        mappedSubcategoryCount,
        usedCount,
      };
    })
    .filter((item) => item.directCategoryCount > 0 || item.mappedSubcategoryCount > 0)
    .sort((a, b) => b.usedCount - a.usedCount || a.name.localeCompare(b.name));

  const unmappedRecognizedSubcategories = subcategoryMetrics
    .filter((item) => (item.count || 0) > 0 && !CATEGORY_BY_SUBCATEGORY.has(item.name))
    .map((item) => ({
      name: item.name,
      count: item.count || 0,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const categoryCoverageTotal = categoryComparisons.reduce((sum, item) => sum + item.usedCount, 0);

  return {
    totalOpened,
    categoryCoverageTotal,
    currentNotTagged: Math.max(0, totalOpened - categoryCoverageTotal),
    unmappedRecognizedTotal: unmappedRecognizedSubcategories.reduce((sum, item) => sum + item.count, 0),
    unmappedRecognizedSubcategories,
    categoryComparisons,
  };
}

export async function fetchIncomingNotTaggedTickets(startStr, endStr, category = 'all') {
  const normalizedCategory = category && category !== 'all' ? String(category) : 'all';
  const cacheKey = `${startStr}_${endStr}_${normalizedCategory}`;
  const cached = _incomingNotTaggedCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const categoryTagNames = new Map(CATEGORY_TAGS.map((item) => [normalizeName(item.hsName), item.name]));
  const subcategoryTagNames = new Map(SUBCATEGORY_TAGS.map((item) => [normalizeName(item.hsName), item.name]));

  const conversations = await listConversationsCreatedInRange(startStr, endStr);
  const tickets = [];

  for (const conversation of conversations) {
    const tagNames = getTagNames(conversation);
    const normalizedTags = tagNames.map(normalizeName);

    const matchedCategories = Array.from(
      new Set(normalizedTags.map((tag) => categoryTagNames.get(tag)).filter(Boolean))
    );
    const matchedSubcategories = Array.from(
      new Set(normalizedTags.map((tag) => subcategoryTagNames.get(tag)).filter(Boolean))
    );
    const matchedMappedCategories = Array.from(
      new Set(matchedSubcategories.map((name) => CATEGORY_BY_SUBCATEGORY.get(name)).filter(Boolean))
    );

    const isGlobalNotTagged = matchedCategories.length === 0 && matchedMappedCategories.length === 0;
    const isCategoryResidual = normalizedCategory !== 'all'
      ? matchedCategories.includes(normalizedCategory) &&
        !matchedMappedCategories.includes(normalizedCategory)
      : false;

    if (!isGlobalNotTagged && !isCategoryResidual) continue;

    const assignee =
      conversation?.assignedTo?.firstName && conversation?.assignedTo?.lastName
        ? `${conversation.assignedTo.firstName} ${conversation.assignedTo.lastName}`.trim()
        : conversation?.assignedTo?.name ||
          conversation?.owner?.name ||
          conversation?.primaryCustomer?.email ||
          null;

    tickets.push({
      id: conversation?.id,
      number: conversation?.number ?? null,
      subject: conversation?.subject || '(No subject)',
      createdAt: conversation?.createdAt || conversation?.createdAtUtc || null,
      assignee,
      matchedCategories,
      matchedSubcategories,
      matchedMappedCategories,
      tags: tagNames,
    });
  }

  const data = {
    startStr,
    endStr,
    category: normalizedCategory,
    totalTickets: tickets.length,
    tickets: tickets.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  };

  _incomingNotTaggedCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  return data;
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
    const opened = emailReport?.current?.volume?.emailConversations ?? 0;
    const resolved = emailReport?.current?.resolutions?.resolved ?? 0;
    const closed = emailReport?.current?.resolutions?.closed ?? 0;
    const noReply = Math.max(0, closed - resolved);

    const [closedCategoryMetrics, closedSubcategoryMetrics, incomingCategoryMetrics, incomingSubcategoryMetrics] = await Promise.all([
      fetchTaggedClosureMetrics(baseParams, CATEGORY_TAGS),
      fetchTaggedClosureMetrics(baseParams, SUBCATEGORY_TAGS),
      fetchTaggedIncomingMetrics(baseParams, CATEGORY_TAGS),
      fetchTaggedIncomingMetrics(baseParams, SUBCATEGORY_TAGS),
    ]);

    const unresolvedSubcategoryTags = closedSubcategoryMetrics
      .filter(x => !x.tagId)
      .map(x => x.hsName);

    const resolvedSubcategoryTags = closedSubcategoryMetrics
      .filter(x => x.tagId)
      .map(x => ({
        hsName: x.hsName,
        tagId: x.tagId,
        both: x.both,
        withReply: x.withReply,
        noReply: x.noReply,
      }))
      .sort((a, b) => b.both - a.both);

    const incomingDebug = buildIncomingDebug(
      incomingCategoryMetrics,
      incomingSubcategoryMetrics,
      opened
    );

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
      debug: {
        incoming: incomingDebug,
        unresolvedSubcategoryTags,
        resolvedSubcategoryTags,
      },
    };
  } catch (e) {
    console.error(`Error fetching buckets ${startStr}-${endStr}:`, e.message);
    return {
      closed: {
        category: { withReply: [], noReply: [], both: [] },
        subcategory: { withReply: [], noReply: [], both: [] },
      },
      incoming: {
        category: [],
        subcategory: [],
      },
      debug: {
        incoming: {
          totalOpened: 0,
          categoryCoverageTotal: 0,
          currentNotTagged: 0,
          unmappedRecognizedTotal: 0,
          unmappedRecognizedSubcategories: [],
          categoryComparisons: [],
        },
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
    runningBacklog = runningBacklog + weeklyMetrics[i].opened - weeklyMetrics[i].totalClosed;
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
    { id: 905519, name: 'Nestor Cortez' },
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
    { id: 929232, name: 'Julius Lubitos' },
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
    : await hsGet('/reports/email', {
        start: baseStart,
        end: baseEnd,
        mailbox: mailboxId,
      }).catch(() => null);

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
            start: baseStart,
            end: baseEnd,
            mailbox: mailboxId,
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
