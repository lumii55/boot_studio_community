// Cloudflare Turnstile verification for the actions that spammers want (uploads, reports).

import { fail } from './http.js';
import { clientIp } from './ratelimit.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function requireTurnstile(c, token) {
  if (!c.env.TURNSTILE_SECRET) throw fail(503, 'not_configured', 'Anti-spam check is not configured');
  if (typeof token !== 'string' || !token || token.length > 2048) {
    throw fail(400, 'turnstile_required', 'Complete the anti-robot check');
  }
  const body = new FormData();
  body.append('secret', c.env.TURNSTILE_SECRET);
  body.append('response', token);
  body.append('remoteip', clientIp(c.request));
  let outcome;
  try {
    const response = await fetch(VERIFY_URL, { method: 'POST', body });
    outcome = await response.json();
  } catch {
    throw fail(503, 'turnstile_unavailable', 'Anti-robot check unavailable, try again');
  }
  if (!outcome || outcome.success !== true) throw fail(403, 'turnstile_failed', 'Anti-robot check failed, try again');
}
