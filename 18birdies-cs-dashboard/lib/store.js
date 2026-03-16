// Simple data store - uses Vercel KV if available, falls back to in-memory
// In production, add Vercel KV (free tier) to persist historical snapshots

let _memStore = {};

async function getKV() {
  try {
    // Try Vercel KV if configured
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const { kv } = await import('@vercel/kv');
      return kv;
    }
  } catch {}
  return null;
}

export async function storeSnapshot(key, data) {
  const kv = await getKV();
  const value = JSON.stringify(data);
  if (kv) {
    await kv.set(key, value);
  } else {
    _memStore[key] = value;
  }
}

export async function getSnapshot(key) {
  const kv = await getKV();
  let raw;
  if (kv) {
    raw = await kv.get(key);
  } else {
    raw = _memStore[key];
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function listSnapshots() {
  const kv = await getKV();
  if (kv) {
    const keys = await kv.keys('snapshot:*');
    const values = await Promise.all(keys.map(k => kv.get(k)));
    return values
      .map((v, i) => ({ key: keys[i], ...JSON.parse(v || '{}') }))
      .sort((a, b) => a.key.localeCompare(b.key));
  } else {
    return Object.entries(_memStore)
      .filter(([k]) => k.startsWith('snapshot:'))
      .map(([key, v]) => ({ key, ...JSON.parse(v) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}
