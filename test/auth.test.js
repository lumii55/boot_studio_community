import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, OWNER_GITHUB_ID, ORIGIN } from './helpers.js';

test('GitHub sign-in creates the account and a working session; tokens are stored hashed', async () => {
  const h = createHarness();
  const { token, user } = await h.signIn('Stella-Test', { name: 'Stella' });
  assert.equal(user.handle, 'stella-test');
  assert.equal(user.role, 'user');
  assert.equal(user.trust, 0);
  const me = await h.request('GET', '/v1/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.handle, 'stella-test');
  assert.equal(me.data.display_name, 'Stella');
  assert.equal(h.db.row('SELECT COUNT(*) AS n FROM sessions').n, 1);
  assert.equal(h.db.row('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', token).n, 0);
  // GitHub was asked for no scopes and the GitHub token was not kept anywhere.
  assert.ok(!JSON.stringify(h.db.rows('SELECT * FROM users')).includes('gho_'));
});

test('the owner account is recognised by GitHub id and gets the configured Discord link', async () => {
  const h = createHarness({ env: { OWNER_DISCORD_ID: '144218624300050035' } });
  const { user } = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  assert.equal(user.role, 'owner');
  assert.equal(user.discord_id, '144218624300050035');
  const other = await h.signIn('someone-else');
  assert.equal(other.user.discord_id, null);
});

test('authorize URL carries state and no scope; return path is restricted to a fragment', async () => {
  const h = createHarness();
  const start = await h.request('GET', '/v1/auth/github/start?return=https%3A%2F%2Fevil.example');
  assert.equal(start.status, 302);
  const url = new URL(start.headers.get('Location'));
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), null);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.test/v1/auth/github/callback');
  const saved = h.db.row('SELECT return_to FROM oauth_states');
  assert.equal(saved.return_to, '#community');
});

test('state and grant are single use and expire', async () => {
  const h = createHarness();
  h.net.githubProfiles.set('c1', { id: 5, login: 'a', created_at: '2020-01-01T00:00:00Z' });
  const start = await h.request('GET', '/v1/auth/github/start');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const first = await h.request('GET', `/v1/auth/github/callback?code=c1&state=${state}`);
  const grant = new URLSearchParams(new URL(first.headers.get('Location')).hash.slice(1)).get('bas-auth');
  assert.ok(grant);
  const replay = await h.request('GET', `/v1/auth/github/callback?code=c1&state=${state}`);
  assert.match(new URL(replay.headers.get('Location')).hash, /bas-auth-error=expired/);

  h.advance(121000);
  const late = await h.request('POST', '/v1/auth/exchange', { json: { grant } });
  assert.equal(late.status, 400);
  assert.equal(late.data.error.code, 'invalid_grant');
});

test('denied authorization and banned accounts come back to the site with an error', async () => {
  const h = createHarness();
  const start = await h.request('GET', '/v1/auth/github/start');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const denied = await h.request('GET', `/v1/auth/github/callback?error=access_denied&state=${state}`);
  assert.equal(new URL(denied.headers.get('Location')).href, 'https://site.test/bas/#bas-auth-error=denied');

  const { user } = await h.signIn('spammer');
  h.db.sqlite.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(user.id);
  await assert.rejects(h.signIn('spammer'), /bas-auth-error=banned/);
});

test('signing in to a banned account shows why (one-time code, no session)', async () => {
  const h = createHarness();
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const spammer = await h.signIn('spammer');
  await h.request('POST', '/v1/mod/users/spammer/sanctions', { token: owner.token, json: { kind: 'ban', reason: 'Spam links in every upload' } });
  const failure = await h.signIn('spammer').catch((error) => error.message);
  const fragment = new URLSearchParams(String(failure).replace('sign-in failed: ', ''));
  assert.equal(fragment.get('bas-auth-error'), 'banned');
  assert.equal(fragment.get('bas-auth'), null);
  const sessionsBefore = h.db.row('SELECT COUNT(*) AS n FROM sessions').n;
  const res = await h.request('POST', '/v1/auth/exchange', { json: { grant: fragment.get('notice') } });
  assert.equal(res.status, 403);
  assert.deepEqual({ ...res.data.error.details, since: null }, {
    kind: 'ban', reason: 'Spam links in every upload', since: null, until: null, handle: 'spammer', contact: 'bootanimstudio@gmail.com',
  });
  assert.equal(h.db.row('SELECT COUNT(*) AS n FROM sessions').n, sessionsBefore); // no session was created
  assert.equal((await h.request('POST', '/v1/auth/exchange', { json: { grant: fragment.get('notice') } })).data.error.code, 'invalid_grant'); // one-time
});

test('invalid or missing tokens get 401; logout ends the session', async () => {
  const h = createHarness();
  assert.equal((await h.request('GET', '/v1/me')).status, 401);
  assert.equal((await h.request('GET', '/v1/me', { token: 'x'.repeat(43) })).status, 401);
  const { token } = await h.signIn('someone');
  assert.equal((await h.request('POST', '/v1/auth/logout', { token })).status, 200);
  assert.equal((await h.request('GET', '/v1/me', { token })).status, 401);
});

test('CORS only for the site origin; preflight works', async () => {
  const h = createHarness();
  const ok = await h.request('GET', '/v1/health');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const other = await h.request('GET', '/v1/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await h.request('OPTIONS', '/v1/animations');
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('unknown routes and methods', async () => {
  const h = createHarness();
  assert.equal((await h.request('GET', '/nope')).status, 404);
  assert.equal((await h.request('DELETE', '/v1/health')).status, 405);
});

test('no raw IP address is stored anywhere', async () => {
  const h = createHarness();
  await h.signIn('someone');
  const dump = JSON.stringify(h.db.rows('SELECT * FROM rate_windows')) + JSON.stringify(h.db.rows('SELECT * FROM download_marks'));
  assert.ok(!dump.includes('203.0.113.7'), dump);
});

test('sign-in from an allowed preview copy of the site returns there; other sites fall back to the public one', async () => {
  const preview = 'http://localhost:8095/';
  const h = createHarness({ env: { PREVIEW_SITE_URLS: preview } });
  h.net.githubProfiles.set('p1', { id: 41, login: 'previewer', created_at: '2020-01-01T00:00:00Z' });
  const start = await h.request('GET', `/v1/auth/github/start?return=%23community&site=${encodeURIComponent(preview)}`);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const done = await h.request('GET', `/v1/auth/github/callback?code=p1&state=${state}`);
  const back = new URL(done.headers.get('Location'));
  assert.equal(back.origin + back.pathname, 'http://localhost:8095/');
  assert.ok(new URLSearchParams(back.hash.slice(1)).get('bas-auth'));

  const denied = await h.request('GET', '/v1/auth/github/start?site=http%3A%2F%2Flocalhost%3A8095%2F');
  const deniedState = new URL(denied.headers.get('Location')).searchParams.get('state');
  const refused = await h.request('GET', `/v1/auth/github/callback?error=access_denied&state=${deniedState}`);
  assert.equal(refused.headers.get('Location'), 'http://localhost:8095/#bas-auth-error=denied');

  for (const other of ['https://evil.example/', 'http://localhost:9999/', 'http://localhost:8095/x']) {
    const s = await h.request('GET', `/v1/auth/github/start?site=${encodeURIComponent(other)}`);
    const st = new URL(s.headers.get('Location')).searchParams.get('state');
    const r = await h.request('GET', `/v1/auth/github/callback?error=access_denied&state=${st}`);
    assert.equal(r.headers.get('Location'), 'https://site.test/bas/#bas-auth-error=denied', other);
  }
  // Without PREVIEW_SITE_URLS no preview is accepted at all.
  const plain = createHarness();
  const s = await plain.request('GET', `/v1/auth/github/start?site=${encodeURIComponent(preview)}`);
  assert.equal(plain.db.row('SELECT site_url FROM oauth_states').site_url, null);
  assert.equal(s.status, 302);
});

test('the deployed configuration allows exactly the public site and the owner preview', async () => {
  const { readFileSync } = await import('node:fs');
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"ALLOWED_ORIGINS": "https:\/\/lumii55\.github\.io,http:\/\/localhost:8095"/);
  assert.match(config, /"PREVIEW_SITE_URLS": "http:\/\/localhost:8095\/"/);
});
