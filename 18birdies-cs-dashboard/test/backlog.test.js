import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { getCurrentBacklog } from '../lib/helpscout.js';

function mockHelpScout(t, pages) {
  const requestedPages = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname === '/v2/oauth2/token') {
      return Response.json({ access_token: 'test-only', expires_in: 3600 });
    }
    assert.equal(url.origin, 'https://api.helpscout.net');
    assert.equal(url.pathname, '/v2/conversations');
    assert.equal(url.searchParams.get('status'), 'active');
    assert.equal(url.searchParams.get('sortField'), 'createdAt');
    assert.equal(url.searchParams.has('assigned_to'), false);
    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    const data = pages[page - 1];
    assert.ok(data, `Unexpected request for page ${page}`);
    return data instanceof Response ? data : Response.json(data);
  });
  return requestedPages;
}

function paginated(records, size = 25) {
  const totalPages = Math.ceil(records.length / size);
  return Array.from({ length: Math.max(1, totalPages) }, (_, index) => ({
    page: { number: index + 1, totalElements: records.length, totalPages },
    _embedded: { conversations: records.slice(index * size, (index + 1) * size) },
  }));
}

test('187 returned records with ten closed records produce 177 active tickets across all eight pages', async t => {
  const records = Array.from({ length: 187 }, (_, i) => ({
    id: i + 1, status: i < 177 ? 'active' : 'closed',
    assignee: i < 174 ? { id: 100 } : i === 176 ? { id: 200 } : undefined,
  }));
  const requested = mockHelpScout(t, paginated(records));
  assert.deepEqual(await getCurrentBacklog(), { total: 177, active: 177, pending: null });
  assert.deepEqual(requested, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('deduplicates across pages and respects a later closed status', async t => {
  mockHelpScout(t, paginated([
    { id: 1, status: 'active' }, { id: 2, status: 'active' },
    { id: 1, status: 'active' }, { id: 2, status: 'closed' },
    { id: 3, status: 'pending' }, { id: 4, status: 'spam' },
  ], 2));
  assert.deepEqual(await getCurrentBacklog(), { total: 1, active: 1, pending: null });
});

test('a genuinely empty mailbox reports zero', async t => {
  mockHelpScout(t, paginated([]));
  assert.deepEqual(await getCurrentBacklog(), { total: 0, active: 0, pending: null });
});

test('a failed later page makes the count unavailable instead of reporting a partial total', async t => {
  const pages = paginated([{ id: 1, status: 'active' }, { id: 2, status: 'active' }], 1);
  pages[1] = new Response('Request failed', { status: 400 });
  mockHelpScout(t, pages);
  assert.deepEqual(await getCurrentBacklog(), { total: null, active: null, pending: null });
});

test('missing pagination or records cannot be mistaken for zero', async t => {
  for (const page of [
    { _embedded: { conversations: [{ id: 1, status: 'active' }] } },
    { page: { totalElements: 25, totalPages: 1 } },
    ...paginated([{ status: 'active' }]),
  ]) {
    mockHelpScout(t, [page]);
    assert.deepEqual(await getCurrentBacklog(), { total: null, active: null, pending: null });
    t.mock.restoreAll();
  }
});

test('dashboard distinguishes an unavailable backlog from a verified zero', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = html.match(/function getCurrentBacklogAnchor\(\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(source);
  for (const [value, expected] of [[null, null], [undefined, null], [0, 0], [177, 177]]) {
    const context = vm.createContext({ allData: { currentBacklog: value } });
    assert.equal(vm.runInContext(`${source}; getCurrentBacklogAnchor()`, context), expected);
  }
});
