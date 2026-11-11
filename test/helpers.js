// Test harness: the real Worker code against an in-memory D1 (node:sqlite), an in-memory R2 and a fake
// network (GitHub, Turnstile, Discord, GitHub OIDC keys). No Cloudflare tooling needed.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle, makeContext } from '../src/index.js';
import { resetJwksCache } from '../src/lib/oidc.js';
import { runScheduled } from '../src/scheduled.js';

const SCHEMA = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

// --- D1 -----------------------------------------------------------------------------------------

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    for (const value of params) {
      if (value === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${this.sql}`);
    }
    return new Statement(this.db, this.sql, params);
  }
  prepared() {
    return this.db.sqlite.prepare(this.sql);
  }
  returnsRows() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
  }
  async first(column) {
    const row = this.prepared().get(...this.params);
    if (!row) return null;
    const plain = { ...row };
    return column ? plain[column] : plain;
  }
  async all() {
    return this.execute();
  }
  async run() {
    return this.execute();
  }
  execute() {
    const stmt = this.prepared();
    if (this.returnsRows()) {
      const results = stmt.all(...this.params).map((row) => ({ ...row }));
      return { success: true, results, meta: { changes: results.length } };
    }
    const info = stmt.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.sqlite.exec(SCHEMA);
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }
  row(sql, ...params) {
    const row = this.sqlite.prepare(sql).get(...params);
    return row ? { ...row } : null;
  }
  rows(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params).map((row) => ({ ...row }));
  }
}

// --- R2 -----------------------------------------------------------------------------------------

async function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value && typeof value.getReader === 'function') return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('unsupported R2 value');
}

export class FakeR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, options = {}) {
    const bytes = await toBytes(value);
    if (options.sha256) {
      const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      if (digest !== options.sha256) throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
    }
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata || {} });
    return { key, size: bytes.byteLength };
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, httpMetadata: object.httpMetadata, body: new Response(object.bytes).body };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  has(key) {
    return this.objects.has(key);
  }
}

// --- network --------------------------------------------------------------------------------------

export class FakeNetwork {
  constructor() {
    this.calls = [];
    this.githubProfiles = new Map(); // code -> profile
    this.dispatchStatus = 204;
    this.jwks = { keys: [] };
    this.discordMessages = [];
    this.nextDiscordId = 1000;
  }
  async fetch(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
    this.calls.push({ method: request.method, url: url.href, headers: Object.fromEntries(request.headers), body: text });
    const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

    if (url.href === 'https://github.com/login/oauth/access_token') {
      const { code } = JSON.parse(text);
      return reply(200, this.githubProfiles.has(code) ? { access_token: `gho_${code}` } : { error: 'bad_verification_code' });
    }
    if (url.href === 'https://api.github.com/user') {
      const code = (request.headers.get('Authorization') || '').replace('Bearer gho_', '');
      const profile = this.githubProfiles.get(code);
      return profile ? reply(200, profile) : reply(401, { message: 'Bad credentials' });
    }
    if (url.pathname.endsWith('/actions/workflows/moderation.yml/dispatches')) return reply(this.dispatchStatus);
    if (url.href === 'https://token.actions.githubusercontent.com/.well-known/jwks') return reply(200, this.jwks);
    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const form = new URLSearchParams(text.includes('Content-Disposition') ? '' : text);
      const token = form.get('response') || (/name="response"\r\n\r\n([^\r]*)/.exec(text) || [])[1];
      return reply(200, { success: token === 'turnstile-ok' });
    }
    if (url.hostname === 'discord.com') {
      const body = text ? JSON.parse(text) : null;
      this.discordMessages.push({ method: request.method, path: url.pathname, body });
      return reply(200, { id: String(this.nextDiscordId++) });
    }
    return reply(599, { error: `unexpected fetch ${request.method} ${url.href}` });
  }
  dispatches() {
    return this.calls.filter((call) => call.url.endsWith('/dispatches')).map((call) => JSON.parse(call.body).inputs.job_id);
  }
}

// --- harness --------------------------------------------------------------------------------------

export const PUBLIC_URL = 'https://api.test';
export const SITE_URL = 'https://site.test/bas/';
export const ORIGIN = 'https://site.test';
export const OWNER_GITHUB_ID = 777;
export const DAY = 86400000;

export function createHarness({ now = Date.UTC(2026, 10, 11, 12), env: extraEnv = {} } = {}) {
  resetJwksCache();
  const net = new FakeNetwork();
  globalThis.fetch = (input, init) => net.fetch(input, init);
  const db = new FakeD1();
  const files = new FakeR2();
  const env = {
    DB: db,
    FILES: files,
    PUBLIC_URL,
    SITE_URL,
    ALLOWED_ORIGINS: ORIGIN,
    OWNER_GITHUB_ID: String(OWNER_GITHUB_ID),
    MODERATION_REPO: 'lumii55/boot_studio_community',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
    TURNSTILE_SECRET: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'site-key',
    GH_DISPATCH_TOKEN: 'dispatch-token',
    DISCORD_BOT_TOKEN: 'bot-token',
    DISCORD_MOD_CHANNEL_ID: '123456789012345678',
    ...extraEnv,
  };
  const h = {
    net,
    db,
    files,
    env,
    now,
    pending: [],
    advance(ms) {
      h.now += ms;
    },
    async settle() {
      while (h.pending.length) await Promise.allSettled(h.pending.splice(0));
    },
    async request(method, path, { token, json: body, raw, headers = {} } = {}) {
      const init = { method, headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7', ...headers } };
      if (token) init.headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      } else if (raw !== undefined) {
        init.body = raw;
        init.headers['Content-Length'] = String(raw.byteLength);
      }
      const ctx = { waitUntil: (promise) => h.pending.push(promise) };
      const response = await handle(new Request(PUBLIC_URL + path, init), env, ctx, h.now);
      await h.settle();
      const type = response.headers.get('Content-Type') || '';
      const data = type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, data };
    },
    async scheduled() {
      const ctx = { waitUntil: (promise) => h.pending.push(promise) };
      await runScheduled(makeContext(new Request('https://scheduled.invalid/'), env, ctx, h.now));
      await h.settle();
    },
    // Full GitHub sign-in through the real endpoints. Returns {token, user}.
    async signIn(login, { id, createdDaysAgo = 400, name } = {}) {
      const githubId = id ?? (Math.abs([...login].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7)) % 1e8) + 1000;
      const code = `code-${login}-${h.now}`;
      net.githubProfiles.set(code, {
        id: githubId,
        login,
        name: name ?? login,
        avatar_url: `https://avatars.githubusercontent.com/u/${githubId}`,
        created_at: new Date(h.now - createdDaysAgo * DAY).toISOString(),
      });
      const start = await h.request('GET', '/v1/auth/github/start?return=%23community');
      const state = new URL(start.headers.get('Location')).searchParams.get('state');
      const back = await h.request('GET', `/v1/auth/github/callback?code=${code}&state=${state}`);
      const fragment = new URL(back.headers.get('Location')).hash.slice(1);
      const grant = new URLSearchParams(fragment).get('bas-auth');
      if (!grant) throw new Error(`sign-in failed: ${fragment}`);
      const exchanged = await h.request('POST', '/v1/auth/exchange', { json: { grant } });
      const user = db.row('SELECT * FROM users WHERE github_id = ?', githubId);
      return { token: exchanged.data.token, user };
    },
  };
  return h;
}

// --- fixtures -------------------------------------------------------------------------------------

export async function sha256Hex(bytes) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

let fixtureCounter = 0;
export function fakeZip(label = '') {
  fixtureCounter += 1;
  // Contents don't matter to the Worker (the pipeline checks them); only the bytes and hash do.
  return new TextEncoder().encode(`PK\u0003\u0004 fake animation ${label} #${fixtureCounter} ${'x'.repeat(64)}`);
}

export function pngBytes(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

export function webpBytes(width, height) {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const w = width - 1;
  const hh = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([hh & 0xff, (hh >> 8) & 0xff, (hh >> 16) & 0xff], 27);
  return bytes;
}

export function jpegBytes(width, height) {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
  ]);
}

// Uploads an animation through the real endpoints and returns its id (status: scanning).
export async function uploadAnimation(h, token, { title = 'Neon boot', bytes = fakeZip(title), tags = ['neon'], extra = {} } = {}) {
  const draft = await h.request('POST', '/v1/animations', {
    token,
    json: {
      title,
      description: 'A test animation',
      tags,
      license: 'cc-by-4.0',
      sha256: await sha256Hex(bytes),
      size_bytes: bytes.byteLength,
      turnstile_token: 'turnstile-ok',
      ...extra,
    },
  });
  if (draft.status !== 201) throw new Error(`draft failed: ${JSON.stringify(draft.data)}`);
  const sent = await h.request('PUT', `/v1/animations/${draft.data.id}/file`, { token, raw: bytes });
  if (sent.status !== 202) throw new Error(`upload failed: ${JSON.stringify(sent.data)}`);
  return draft.data.id;
}

// --- GitHub Actions OIDC --------------------------------------------------------------------------

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export async function oidcSigner(h) {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  h.net.jwks = { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'test-kid', alg: 'RS256', use: 'sig' }] };
  return async (overrides = {}, { kid = 'test-kid', signWith = keys.privateKey } = {}) => {
    const seconds = Math.floor(h.now / 1000);
    const claims = {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'bas-community',
      repository: 'lumii55/boot_studio_community',
      ref: 'refs/heads/main',
      event_name: 'workflow_dispatch',
      job_workflow_ref: 'lumii55/boot_studio_community/.github/workflows/moderation.yml@refs/heads/main',
      iat: seconds,
      nbf: seconds,
      exp: seconds + 300,
      ...overrides,
    };
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
  };
}

// Runs one queued pipeline job as the moderation workflow would.
export async function finishJob(h, sign, jobId, result) {
  const token = await sign();
  const got = await h.request('GET', `/v1/pipeline/jobs/${jobId}`, { token });
  if (got.status !== 200) throw new Error(`job fetch failed: ${JSON.stringify(got.data)}`);
  const posted = await h.request('POST', `/v1/pipeline/jobs/${jobId}/result`, { token, json: result });
  if (posted.status !== 200) throw new Error(`result failed: ${JSON.stringify(posted.data)}`);
  return got.data;
}

export function lastJob(h, kind, subjectId) {
  return h.db.row('SELECT * FROM pipeline_jobs WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', kind, subjectId);
}

export const CLEAN = { verdict: 'clean', findings: [], metadata: { width: 1080, height: 2400, fps: 30, frame_count: 90, parts: 2 } };
