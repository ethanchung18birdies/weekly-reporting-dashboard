// Optional shared persistence using the existing Vercel KV / Upstash REST config.
// Without a configured store the UI explicitly falls back to this browser's history.
export async function recordBacklogHistory(weeks, observation, mailboxId, fetcher = fetch) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { snapshots: [], storage: 'browser' };

  const key = week => `backlog:v1:${mailboxId || 'all'}:active:${week.startStr}`;
  const commands = [];
  if (observation) {
    const week = weeks.find(w => w.startStr === observation.weekStart);
    const score = Date.parse(observation.observedAt);
    if (week && Number.isInteger(observation.backlog) && observation.backlog >= 0 && Number.isFinite(score)) {
      // Sorted observations keep an older, slower request from replacing a newer count.
      commands.push(['ZADD', key(week), score, JSON.stringify(observation)]);
      commands.push(['ZREMRANGEBYRANK', key(week), 0, -2]);
      commands.push(['EXPIRE', key(week), 60 * 60 * 24 * 365]);
    }
  }
  const offset = commands.length;
  commands.push(...weeks.map(week => ['ZRANGE', key(week), -1, -1]));
  try {
    const response = await fetcher(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Backlog storage HTTP ${response.status}`);
    const results = await response.json();
    if (!Array.isArray(results) || results.length !== commands.length || results.some(r => r.error)) {
      throw new Error('Invalid backlog storage response');
    }
    const snapshots = results.slice(offset).flatMap(r => (r.result || []).map(value => JSON.parse(value)));
    return { snapshots, storage: 'shared' };
  } catch (error) {
    console.error('Backlog history unavailable:', error.message);
    return { snapshots: [], storage: 'browser', unavailable: true };
  }
}
