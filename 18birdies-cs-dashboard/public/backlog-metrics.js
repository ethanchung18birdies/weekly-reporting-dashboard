// Backlog is a measured stock. Email opened/closed totals are a separate flow.
globalThis.BacklogMetrics = (() => {
  function count(value) {
    if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !value.trim()) return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  function mergeHistory(weeks, ...histories) {
    const byWeek = new Map();
    for (const history of histories) {
      for (const item of Array.isArray(history) ? history : []) {
        const week = weeks.find(w => w.startStr === item?.weekStart);
        const time = Date.parse(item?.observedAt);
        if (!week || count(item?.backlog) === null || !Number.isFinite(time)) continue;
        if (time < Date.parse(`${week.startStr}T00:00:00Z`) || time > Date.parse(`${week.endStr}T23:59:59.999Z`)) continue;
        if (!byWeek.has(item.weekStart) || time > Date.parse(byWeek.get(item.weekStart).observedAt)) {
          byWeek.set(item.weekStart, { ...item, backlog: count(item.backlog) });
        }
      }
    }
    return weeks.map(w => byWeek.get(w.startStr) || null);
  }

  function comparison(current, previous) {
    const currentCount = count(current?.backlog);
    const previousCount = count(previous?.backlog);
    if (currentCount === null || previousCount === null) return null;
    const change = currentCount - previousCount;
    return { change, burn: change === 0 ? 0 : -change, percent: previousCount > 0 ? change / previousCount * 100 : null };
  }

  function model(data, localHistory = []) {
    const weeks = data.weeks || [];
    const latest = weeks.length - 1;
    const current = count(data.currentBacklog);
    const live = current === null || latest < 0 ? [] : [{
      weekStart: weeks[latest].startStr,
      observedAt: data.backlogObservedAt || data.fetchedAt,
      backlog: current,
    }];
    const snapshots = mergeHistory(weeks, localHistory, data.backlogHistory, live);
    // A failed live lookup must never masquerade as a fresh saved observation.
    const liveSnapshot = mergeHistory(weeks, live)[latest];
    return { current, snapshots, liveComparison: comparison(liveSnapshot, snapshots[latest - 1]) };
  }

  function flow(week) {
    const closed = count(week?.totalClosed);
    const opened = count(week?.opened);
    return closed === null || opened === null ? null : closed - opened;
  }

  return { count, mergeHistory, comparison, model, flow };
})();
