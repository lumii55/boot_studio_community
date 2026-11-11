// Fixed-window rate limits stored in D1. One statement per check.

import { fail } from './http.js';

export async function rateLimit(c, name, subject, [max, seconds]) {
  const windowMs = seconds * 1000;
  const windowStart = Math.floor(c.now / windowMs) * windowMs;
  const key = `${name}:${subject}`;
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_windows (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first();
  if (row.count > max) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - c.now) / 1000));
    throw fail(429, 'rate_limited', 'Too many requests, try again later', { retryAfter, details: { retry_after: retryAfter } });
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
