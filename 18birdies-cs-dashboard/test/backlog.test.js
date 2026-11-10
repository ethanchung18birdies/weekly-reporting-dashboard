import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../public/backlog-metrics.js';
import { recordBacklogHistory } from '../lib/backlog-history.js';
import { fetchAllMetrics } from '../lib/helpscout.js';

function mockEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const metrics = globalThis.BacklogMetrics;
const weeks = [
  { label: 'W10/26', startStr: '2026-10-26', endStr: '2026-11-01', opened: 719, totalClosed: 676, closed: 564 },
  { label: 'W11/02', startStr: '2026-11-02', endStr: '2026-11-08', opened: 649, totalClosed: 487, closed: 421 },
  { label: 'W11/09', startStr: '2026-11-09', endStr: '2026-11-15', opened: 81, totalClosed: 111, closed: 101 },
];
const live = { weeks, currentBacklog: 236, fetchedAt: '2026-11-09T23:27:30Z' };
// Synthetic history exercises direction independently of the live email totals.
const historical = { weekStart: '2026-11-02', observedAt: '2026-11-06T12:00:00Z', backlog: 400 };

test('live email totals use all closes, not just resolutions with reply', () => {
  assert.equal(metrics.flow(weeks[1]), -162);
  assert.equal(metrics.flow(weeks[2]), 30);
  assert.equal(metrics.flow({ opened: 10, closed: 5 }), null);
});

test('missing live data never becomes zero; a real zero remains valid', () => {
  for (const value of [null, undefined, '', ' ', false, [], {}, -1, 1.5, Infinity]) {
    assert.equal(metrics.count(value), null);
  }
  assert.equal(metrics.count(0), 0);
  assert.equal(metrics.count('236'), 236);
  assert.equal(metrics.model({ ...live, currentBacklog: null }).current, null);
});

test('history is not reconstructed from flow and never changes on a later live refresh', () => {
  const original = metrics.model(live);
  assert.deepEqual(original.snapshots.map(s => s?.backlog ?? null), [null, null, 236]);
  assert.equal(original.liveComparison, null);
  const withHistory = metrics.model({ ...live, backlogHistory: [historical] });
  assert.deepEqual(withHistory.snapshots.map(s => s?.backlog ?? null), [null, 400, 236]);
  assert.deepEqual(withHistory.liveComparison, { change: -164, burn: 164, percent: -41 });
  const updated = metrics.model({ ...live, currentBacklog: 240, fetchedAt: '2026-11-09T23:30:00Z' }, withHistory.snapshots);
  assert.equal(updated.snapshots[1].backlog, 400);
  assert.equal(updated.snapshots[2].backlog, 240);
});

test('comparison handles growth, zero baseline, flat, missing weeks and failed refresh', () => {
  assert.equal(metrics.comparison({ backlog: 200 }, { backlog: 100 }).burn, -100);
  assert.equal(metrics.comparison({ backlog: 0 }, { backlog: 0 }).change, 0);
  assert.equal(metrics.comparison({ backlog: 20 }, { backlog: 0 }).percent, null);
  assert.equal(metrics.comparison({ backlog: 20 }, null), null);
  const stored = metrics.model({ ...live, backlogHistory: [historical] }).snapshots;
  const failed = metrics.model({ ...live, currentBacklog: null }, stored);
  assert.equal(failed.current, null);
  assert.equal(failed.liveComparison, null);
  assert.equal(failed.snapshots[2].backlog, 236); // Clearly recorded, not a fresh live count.
  const gap = { ...historical, weekStart: '2026-10-26', observedAt: '2026-10-30T12:00:00Z' };
  assert.equal(metrics.model({ ...live, backlogHistory: [gap] }).liveComparison, null);
});

test('history rejects bad dates, wrong weeks and malformed counts; newest observation wins', () => {
  const snapshots = metrics.mergeHistory(weeks, [
    historical,
    { ...historical, backlog: 300, observedAt: '2026-11-02T12:00:00Z' },
    { ...historical, backlog: 1, observedAt: '2026-11-09T12:00:00Z' },
    { ...historical, backlog: null, observedAt: '2026-11-07T12:00:00Z' },
    { ...historical, backlog: 2, observedAt: 'invalid' },
  ], 'bad storage');
  assert.equal(snapshots[1].backlog, 400);
});

function dashboard(data) {
  const elements = new Map();
  const storage = new Map();
  const context = vm.createContext({
    BacklogMetrics: metrics,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {} });
      return elements.get(id);
    } },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    Chart: class { constructor(element, config) { this.config = config; } destroy() {} },
  });
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInContext(script.replace(/\n    loadData\(\);\s*$/, ''), context);
  context.inputData = data;
  vm.runInContext('allData = inputData; updateBacklogModel();', context);
  return { elements, run: code => vm.runInContext(code, context) };
}

test('KPI and charts display live API counts and selected-week flow without inventing direction', () => {
  const ui = dashboard(live);
  ui.run("selWeek = 1; renderKPIs(allData.weeks[1], allData.weeks[0], '97', ''); renderBurnChart(); renderBurnRateChart(); renderCallout(allData.weeks[1], false, 5, 97);");
  const text = ui.elements.get('kpiGrid').innerHTML;
  assert.match(text, /Current backlog[\s\S]*?236/);
  assert.match(text, /Net ticket flow[\s\S]*?-162/);
  assert.match(text, /162 more opened than closed/);
  assert.doesNotMatch(text, /Backlog growing|Backlog shrinking|Backlog increased/);
  assert.match(ui.elements.get('paceText').textContent, /direction is unavailable/);
  assert.equal(ui.run('JSON.stringify(charts.burn.config.data.datasets[0].data)'), '[null,null,236]');
  assert.equal(ui.run('charts.burn.config.data.datasets[0].spanGaps'), false);
  assert.equal(ui.run('charts.br.config.data.datasets[0].rawData[1]'), -162);
  ui.run("selWeek = 2; renderKPIs(allData.weeks[2], allData.weeks[1], '111', '');");
  assert.match(ui.elements.get('kpiGrid').innerHTML, /30 more closed than opened/);
});

test('observed direction remains independent of a negative weekly activity balance', () => {
  const ui = dashboard({ ...live, backlogHistory: [
    { weekStart: '2026-10-26', observedAt: '2026-10-30T12:00:00Z', backlog: 600 }, historical,
  ] });
  ui.run("selWeek = 1; renderKPIs(allData.weeks[1], allData.weeks[0], '97', ''); renderCallout(allData.weeks[1], false, 5, 97);");
  assert.match(ui.elements.get('kpiGrid').innerHTML, /162 more opened than closed/);
  assert.match(ui.elements.get('paceText').textContent, /backlog fell by 200 tickets/);
  assert.match(ui.elements.get('kpiGrid').innerHTML, /164 \(41.0%\) since prior-week snapshot/);
});

test('shared history uses mailbox scope and falls back honestly when storage fails', async t => {
  mockEnv(t, 'KV_REST_API_URL', 'https://example.invalid');
  mockEnv(t, 'KV_REST_API_TOKEN', 'test-token');
  let commands;
  const result = await recordBacklogHistory(weeks, historical, 'test-mailbox', async (url, options) => {
    commands = JSON.parse(options.body);
    assert.equal(url, 'https://example.invalid/pipeline');
    return Response.json(commands.map(command => ({ result: command[0] === 'ZRANGE'
      ? command[1].endsWith(historical.weekStart) ? [JSON.stringify(historical)] : [] : 1 })));
  });
  assert.equal(result.storage, 'shared');
  assert.deepEqual(result.snapshots, [historical]);
  assert.match(commands[0][1], /test-mailbox:active:2026-11-02$/);
  assert.equal(commands[0][0], 'ZADD');
  const failed = await recordBacklogHistory(weeks, null, 'test-mailbox', async () => new Response('', { status: 503 }));
  assert.equal(failed.storage, 'browser');
  assert.equal(failed.unavailable, true);
});

test('metrics API maps Help Scout totals, preserves missing backlog, and rejects report failures', async t => {
  mockEnv(t, 'KV_REST_API_URL', '');
  mockEnv(t, 'KV_REST_API_TOKEN', '');
  mockEnv(t, 'HELPSCOUT_MAILBOX_ID', 'test-mailbox');
  let badBacklog = false;
  let badReport = false;
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/oauth2/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (parsed.pathname.endsWith('/conversations')) {
      assert.equal(parsed.searchParams.get('status'), 'active');
      assert.equal(parsed.searchParams.get('mailbox'), 'test-mailbox');
      return Response.json({ page: { totalElements: badBacklog ? null : 236 } });
    }
    if (parsed.pathname.endsWith('/reports/email')) {
      assert.equal(parsed.searchParams.get('mailboxes'), 'test-mailbox');
      return Response.json(badReport ? {} : { current: {
        volume: { emailConversations: 649 }, resolutions: { closed: 487, resolved: 421 },
      } });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  });
  const result = await fetchAllMetrics();
  assert.equal(result.currentBacklog, 236);
  assert.equal(result.weeks.length, 12);
  assert.equal(result.weeks[0].netTicketFlow, -162);
  assert.equal(result.backlogHistoryStorage, 'browser');
  badBacklog = true;
  assert.equal((await fetchAllMetrics()).currentBacklog, null);
  badReport = true;
  await assert.rejects(fetchAllMetrics, /incomplete weekly volume report/);
});
