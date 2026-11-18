const TIME_ZONE = 'America/Los_Angeles';

export function pacificDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

function midnight(dateStr) {
  const target = Date.parse(`${dateStr}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(target)
      || new Date(target).toISOString().slice(0, 10) !== dateStr) {
    throw new Error('Invalid reporting date');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    if (wall === target) return guess;
    guess += target - wall;
  }
  throw new Error('Unable to resolve reporting date');
}

export function reportBounds(startStr, endStr) {
  const start = midnight(startStr);
  const endDay = new Date(`${endStr}T00:00:00Z`);
  // Validate the inclusive end before advancing to the next Pacific midnight.
  midnight(endStr);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const end = midnight(endDay.toISOString().slice(0, 10)) - 1000;
  if (end < start) throw new Error('Reporting end precedes start');
  return { start: new Date(start).toISOString().replace('.000Z', 'Z'),
    end: new Date(end).toISOString().replace('.000Z', 'Z') };
}
