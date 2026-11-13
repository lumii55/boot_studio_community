// Sign-in with GitHub (no scopes: public profile only, no e-mail) and bearer sessions.
//
// Flow: site → /v1/auth/github/start → GitHub → /v1/auth/github/callback → site#bas-auth=<grant>
//       site POSTs the one-time grant to /v1/auth/exchange and receives a session token.
// The GitHub access token is used once to read the profile and then dropped. Only token hashes are stored.

import { CONTACT_EMAIL, GRANT_SECONDS, LIMITS, OAUTH_STATE_MINUTES, RATE, SESSION_DAYS } from './config.js';
import { fail, json, readJson, redirect } from './lib/http.js';
import { clientIp, rateLimit } from './lib/ratelimit.js';
import { personSearchText } from './lib/search.js';
import { newId, randomToken, sha256Hex } from './lib/util.js';

const RETURN_RE = /^#[A-Za-z0-9/_-]{0,100}$/;

// Rate-limit key for sign-in attempts: a hash, so no raw IP address is ever stored.
const ipKey = async (c) => (await sha256Hex(`ip:${clientIp(c.request)}`)).slice(0, 32);

function callbackUrl(env) {
  return new URL('/v1/auth/github/callback', env.PUBLIC_URL).href;
}

// Preview copies of the site the owner tests on (exact URLs, comma separated). Anything else means the public site.
function previewSite(env, requested) {
  const allowed = String(env.PREVIEW_SITE_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return requested && allowed.includes(requested) ? requested : null;
}

function siteRedirect(env, fragment, siteUrl = null) {
  const site = new URL(previewSite(env, siteUrl) || env.SITE_URL);
  site.hash = fragment;
  return redirect(site.href);
}

export async function startGithub(c) {
  await rateLimit(c, 'auth', await ipKey(c), RATE.authMinute);
  if (!c.env.GH_OAUTH_CLIENT_ID) throw fail(503, 'not_configured', 'Sign-in is not configured');
  const requested = c.url.searchParams.get('return') || '#community';
  const returnTo = RETURN_RE.test(requested) ? requested : '#community';
  const siteUrl = previewSite(c.env, c.url.searchParams.get('site'));
  const state = randomToken(24);
  await c.env.DB.prepare('INSERT INTO oauth_states (state, return_to, site_url, expires_at) VALUES (?, ?, ?, ?)')
    .bind(state, returnTo, siteUrl, c.now + OAUTH_STATE_MINUTES * 60000)
    .run();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', c.env.GH_OAUTH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(c.env));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'true');
  return redirect(authorize.href);
}

export async function githubCallback(c) {
  const state = c.url.searchParams.get('state') || '';
  const code = c.url.searchParams.get('code') || '';
  const saved = state
    ? await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING return_to, site_url, expires_at').bind(state).first()
    : null;
  if (!saved || saved.expires_at < c.now) return siteRedirect(c.env, 'bas-auth-error=expired', saved && saved.site_url);
  const back = saved.site_url;
  if (c.url.searchParams.get('error') || !code) return siteRedirect(c.env, 'bas-auth-error=denied', back);

  let profile;
  try {
    profile = await fetchGithubProfile(c.env, code);
  } catch (err) {
    console.error('github sign-in failed', err && err.message);
    return siteRedirect(c.env, 'bas-auth-error=github', back);
  }

  const user = await upsertUser(c, profile);
  const grant = randomToken(32);
  await c.env.DB.prepare('INSERT INTO auth_grants (code_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(grant), user.id, c.now + GRANT_SECONDS * 1000)
    .run();
  // A banned or suspended person gets no session; the one-time code only reads why (POST /v1/auth/exchange answers
  // 403 account_restricted with the punishment, its reason, how long and the contact to contest it).
  if (user.status === 'banned') return siteRedirect(c.env, `bas-auth-error=banned&notice=${grant}`, back);
  if (isSuspended(user, c.now)) return siteRedirect(c.env, `bas-auth-error=suspended&until=${user.suspended_until}&notice=${grant}`, back);
  return siteRedirect(c.env, `bas-auth=${grant}&to=${encodeURIComponent(saved.return_to)}`, back);
}

async function fetchGithubProfile(env, code) {
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'bas-community' },
    body: JSON.stringify({
      client_id: env.GH_OAUTH_CLIENT_ID,
      client_secret: env.GH_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(env),
    }),
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenBody.access_token) throw new Error(`token exchange: ${tokenBody.error || tokenResponse.status}`);
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${tokenBody.access_token}`,
      'User-Agent': 'bas-community',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!userResponse.ok) throw new Error(`user: ${userResponse.status}`);
  const body = await userResponse.json();
  if (!Number.isSafeInteger(body.id) || typeof body.login !== 'string') throw new Error('user: bad profile');
  return body;
}

async function upsertUser(c, profile) {
  const db = c.env.DB;
  const handle = profile.login.toLowerCase();
  const createdAt = Date.parse(profile.created_at || '') || c.now;
  const isOwner = String(profile.id) === String(c.env.OWNER_GITHUB_ID || '');
  const avatar = typeof profile.avatar_url === 'string' && profile.avatar_url.startsWith('https://avatars.githubusercontent.com/')
    ? profile.avatar_url
    : '';
  const displayName = String(profile.name || profile.login).slice(0, LIMITS.displayNameMax);

  // A GitHub login can move to another account after a rename: free the handle first.
  await db.prepare("UPDATE users SET handle = 'gh-' || github_id, search_name = NULL WHERE handle = ? AND github_id <> ?")
    .bind(handle, profile.id)
    .run();
  await db.prepare(
    `INSERT INTO users (id, github_id, handle, display_name, github_avatar_url, role, trust, github_created_at, created_at, updated_at, search_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET
       search_name = CASE WHEN users.handle = excluded.handle THEN users.search_name ELSE NULL END,
       handle = excluded.handle,
       github_avatar_url = excluded.github_avatar_url,
       github_created_at = excluded.github_created_at,
       role = CASE WHEN ? THEN 'owner' ELSE users.role END,
       updated_at = excluded.updated_at`,
  )
    .bind(newId(), profile.id, handle, displayName, avatar, isOwner ? 'owner' : 'user', isOwner ? 2 : 0,
      createdAt, c.now, c.now, personSearchText({ handle, display_name: displayName }), isOwner ? 1 : 0)
    .run();
  // The owner's Discord account is linked from the configuration, so the bot buttons work from day one.
  const ownerDiscord = String(c.env.OWNER_DISCORD_ID || '');
  if (isOwner && /^\d{17,20}$/.test(ownerDiscord)) {
    await db.prepare('UPDATE users SET discord_id = ? WHERE github_id = ? AND discord_id IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE discord_id = ?)')
      .bind(ownerDiscord, profile.id, ownerDiscord)
      .run();
  }
  // Trust is earned when a moderator approves an upload (moderation.js), never from account age alone.
  return db.prepare('SELECT id, status, suspended_until FROM users WHERE github_id = ?').bind(profile.id).first();
}

export async function exchangeGrant(c) {
  await rateLimit(c, 'auth', await ipKey(c), RATE.authMinute);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  if (typeof body.grant !== 'string' || body.grant.length > 100) throw fail(400, 'invalid_grant', 'Invalid sign-in code');
  const row = await c.env.DB.prepare('DELETE FROM auth_grants WHERE code_hash = ? RETURNING user_id, expires_at')
    .bind(await sha256Hex(body.grant))
    .first();
  if (!row || row.expires_at < c.now) throw fail(400, 'invalid_grant', 'Sign-in code expired, sign in again');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  if (!user) throw fail(400, 'invalid_grant', 'Sign-in code expired, sign in again');
  if (isRestricted(user, c.now)) throw await restrictedError(c, user);
  const token = randomToken(32);
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), row.user_id, c.now, c.now + SESSION_DAYS * 86400000)
    .run();
  return json({ token, expires_at: c.now + SESSION_DAYS * 86400000 });
}

export async function logout(c) {
  const hash = await bearerHash(c.request);
  if (hash) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
  return json({ ok: true });
}

async function bearerHash(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
  return match ? sha256Hex(match[1]) : null;
}

// The signed-in user for this request, or null. Cached on the context.
export async function currentUser(c) {
  if (c.userLoaded) return c.user;
  c.userLoaded = true;
  c.user = null;
  const hash = await bearerHash(c.request);
  if (!hash) return null;
  const user = await c.env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, c.now)
    .first();
  if (user && user.status === 'active' && !isSuspended(user, c.now)) c.user = user;
  else if (user && isRestricted(user, c.now)) c.restricted = { user, hash };
  return c.user;
}

const isSuspended = (user, now) => !!(user.suspended_until && user.suspended_until > now);
const isRestricted = (user, now) => user.status === 'banned' || isSuspended(user, now);

// What a punished person is told: the punishment, its reason, since/until when and where to contest it.
export async function restrictionNotice(c, user) {
  const kind = user.status === 'banned' ? 'ban' : 'suspend';
  const row = await c.env.DB.prepare(
    `SELECT reason, created_at FROM sanctions WHERE user_id = ? AND kind = ? AND revoked_at IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).bind(user.id, kind).first();
  return {
    kind,
    reason: row ? row.reason : '',
    since: row ? row.created_at : null,
    until: kind === 'suspend' ? user.suspended_until : null,
    handle: user.handle,
    contact: CONTACT_EMAIL,
  };
}

async function restrictedError(c, user) {
  const notice = await restrictionNotice(c, user);
  return fail(403, 'account_restricted', notice.kind === 'ban' ? 'This account is banned' : 'This account is suspended', { details: notice });
}

export async function requireUser(c) {
  const user = await currentUser(c);
  if (!user && c.restricted) {
    // The session of a punished account grants nothing; its first use explains why and ends it.
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.restricted.hash).run();
    throw await restrictedError(c, c.restricted.user);
  }
  if (!user) throw fail(401, 'sign_in_required', 'Sign in to continue');
  return user;
}

export const isModerator = (user) => !!user && (user.role === 'moderator' || user.role === 'owner');

export async function requireModerator(c) {
  const user = await requireUser(c);
  if (!isModerator(user)) throw fail(403, 'forbidden', 'Moderators only');
  return user;
}

export async function requireOwner(c) {
  const user = await requireUser(c);
  if (user.role !== 'owner') throw fail(403, 'forbidden', 'Owner only');
  return user;
}
