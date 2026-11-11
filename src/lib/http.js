// HTTP helpers: errors with stable codes, JSON responses, CORS and bounded body reading.

export class ApiError extends Error {
  constructor(status, code, message = code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const fail = (status, code, message, extra) => new ApiError(status, code, message, extra);

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...BASE_HEADERS,
      ...headers,
    },
  });
}

export function errorResponse(err) {
  if (err instanceof ApiError) {
    const headers = {};
    if (err.extra.retryAfter) headers['Retry-After'] = String(err.extra.retryAfter);
    const body = { error: { code: err.code, message: err.message } };
    if (err.extra.details) body.error.details = err.extra.details;
    return json(body, err.status, headers);
  }
  console.error('unhandled', err && err.stack ? err.stack : err);
  return json({ error: { code: 'internal', message: 'Internal error' } }, 500);
}

export function redirect(location, status = 302) {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store', ...BASE_HEADERS } });
}

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Turnstile-Token, X-Content-Sha256',
    'Access-Control-Expose-Headers': 'Retry-After, Content-Disposition',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function withHeaders(response, headers) {
  if (!Object.keys(headers).length) return response;
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) copy.headers.set(key, value);
  return copy;
}

export async function readJson(request, maxBytes) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw fail(415, 'expected_json', 'Expected application/json');
  const bytes = await readBytes(request, maxBytes);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw fail(400, 'invalid_json', 'Invalid JSON body');
  }
}

// Reads a small body fully, refusing anything above maxBytes (declared or actual).
export async function readBytes(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > maxBytes) throw fail(413, 'too_large', 'Request body too large');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw fail(413, 'too_large', 'Request body too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
