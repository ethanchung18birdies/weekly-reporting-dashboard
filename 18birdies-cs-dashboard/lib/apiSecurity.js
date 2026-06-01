export function assertSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return;

  const origin = req.headers.origin;
  if (origin) {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      const error = new Error('Cross-origin requests are not allowed');
      error.statusCode = 403;
      throw error;
    }
  }

  const referer = req.headers.referer;
  if (!origin && referer) {
    const refererHost = new URL(referer).host;
    if (refererHost !== host) {
      const error = new Error('Cross-origin requests are not allowed');
      error.statusCode = 403;
      throw error;
    }
  }
}

export function assertExportAccess(req) {
  assertSameOrigin(req);

  const expected = process.env.EXPORT_ACCESS_TOKEN;
  if (!expected) return;

  const headerToken = req.headers['x-export-access-token'];
  const cookieHeader = req.headers.cookie || '';
  const cookieToken = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('export_access_token='))
    ?.split('=')
    .slice(1)
    .join('=');

  if (headerToken === expected || cookieToken === expected) return;

  const error = new Error('Ticket export access denied');
  error.statusCode = 403;
  throw error;
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}
