// Animations: upload (draft → file → automatic checks), feeds, details, downloads, ratings and remixes.

import { currentUser, isModerator, requireUser } from './auth.js';
import { DRAFT_TTL_MS, LICENSES, LIMITS, RATE } from './config.js';
import { fail, json, readJson } from './lib/http.js';
import { clientIp, rateLimit } from './lib/ratelimit.js';
import { requireTurnstile } from './lib/turnstile.js';
import { cleanTags, cleanText, decodeCursor, encodeCursor, newId, randomToken, requireId, SHA256_RE, sha256Hex, utcDay } from './lib/util.js';
import { queueJob } from './pipeline.js';
import { animationKey, previewKey, releaseStorage, releaseStorageStatement, reserveStorage, storageStatus } from './storage.js';
import { ratingRecompute } from './users.js';
import { animationCard, animationDetail, OWNER_COLUMNS, ratingOf } from './views.js';

const STORED = new Set(['scanning', 'review', 'published', 'hidden']);

// Two separate credits:
//   animation_by – who made the boot animation: "self" (the person publishing) or a name;
//   art_by       – who made the art used in it (characters, drawings, logos); empty when it is all original.
// Older uploads may still carry `manufacturer` / `original_author`; they are kept as they were.
function cleanCredits(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const credits = {};
  const animationBy = input.animation_by === undefined || input.animation_by === 'self'
    ? 'self'
    : cleanText(input.animation_by, { field: 'credits.animation_by', min: 1, max: 80 });
  credits.animation_by = animationBy;
  const artBy = cleanText(input.art_by, { field: 'credits.art_by', max: 160 });
  if (artBy) credits.art_by = artBy;
  return credits;
}

function animationFields(body, current = {}) {
  const has = (key) => body[key] !== undefined;
  const fields = {
    title: has('title') || !current.title ? cleanText(body.title, { field: 'title', min: LIMITS.titleMin, max: LIMITS.titleMax }) : current.title,
    description: has('description')
      ? cleanText(body.description, { field: 'description', max: LIMITS.descriptionMax, multiline: true })
      : current.description || '',
    tags: has('tags') ? cleanTags(body.tags, { max: LIMITS.tagsMax, tagMax: LIMITS.tagMax }) : JSON.parse(current.tags || '[]'),
    license: has('license') || !current.license ? String(body.license || '') : current.license,
    credits: has('credits') ? cleanCredits(body.credits) : JSON.parse(current.credits || '{}'),
  };
  if (!LICENSES.includes(fields.license)) throw fail(400, 'invalid_license', 'Choose a license', { details: { field: 'license' } });
  if (current.credits) {
    const previous = JSON.parse(current.credits);
    if (previous.detected_manufacturer) fields.credits.detected_manufacturer = previous.detected_manufacturer;
  }
  return fields;
}

function tagStatements(db, id, tags) {
  return [
    db.prepare('DELETE FROM animation_tags WHERE animation_id = ?').bind(id),
    ...tags.map((tag) => db.prepare('INSERT OR IGNORE INTO animation_tags (tag, animation_id) VALUES (?, ?)').bind(tag, id)),
  ];
}

// POST /v1/animations — metadata first; the file follows with PUT /v1/animations/:id/file.
export async function createDraft(c) {
  const user = await requireUser(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);

  const sha256 = String(body.sha256 || '').toLowerCase();
  const size = Number(body.size_bytes);
  if (!SHA256_RE.test(sha256)) throw fail(400, 'invalid_sha256', 'Invalid file hash');
  if (!Number.isSafeInteger(size) || size < 22) throw fail(400, 'invalid_size', 'Invalid file size');
  if (size > LIMITS.animationBytes) throw fail(413, 'too_large', 'Animations can be at most 50 MB', { details: { max: LIMITS.animationBytes } });
  if ((await storageStatus(c.env)).paused) throw fail(507, 'uploads_paused', 'Uploads are paused for now, try again later');

  const fields = animationFields(body);
  await requireTurnstile(c, body.turnstile_token);
  // Only real attempts count towards the limit; the team is not limited.
  if (!isModerator(user)) {
    await rateLimit(c, 'upload-h', user.id, RATE.uploadHour);
    await rateLimit(c, 'upload-d', user.id, RATE.uploadDay);
  }
  let remixOf = null;
  if (body.remix_of !== undefined && body.remix_of !== null) {
    remixOf = requireId(body.remix_of, 'animation');
    const source = await c.env.DB.prepare("SELECT id FROM animations WHERE id = ? AND status = 'published'").bind(remixOf).first();
    if (!source) throw fail(400, 'invalid_remix', 'The original animation is not available');
  }
  const existing = await c.env.DB.prepare("SELECT id, status FROM animations WHERE sha256 = ? AND status NOT IN ('draft', 'removed')")
    .bind(sha256)
    .first();
  if (existing) {
    if (existing.status === 'rejected') throw fail(409, 'file_rejected', 'This file was already refused by moderation');
    throw fail(409, 'duplicate', 'This animation is already in the community', {
      details: existing.status === 'published' ? { id: existing.id } : {},
    });
  }

  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO animations (id, owner_id, title, description, tags, license, credits, remix_of, status, sha256, size_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  )
    .bind(id, user.id, fields.title, fields.description, JSON.stringify(fields.tags), fields.license, JSON.stringify(fields.credits),
      remixOf, sha256, size, c.now, c.now)
    .run();
  return json({ id, upload_url: new URL(`/v1/animations/${id}/file`, c.env.PUBLIC_URL).href, expires_at: c.now + DRAFT_TTL_MS }, 201);
}

// PUT /v1/animations/:id/file — raw ZIP body, streamed into R2. R2 checks the SHA-256 declared in the draft.
export async function uploadFile(c) {
  const user = await requireUser(c);
  const id = requireId(c.params.id, 'animation');
  const row = await c.env.DB.prepare('SELECT * FROM animations WHERE id = ? AND owner_id = ?').bind(id, user.id).first();
  if (!row) throw fail(404, 'not_found', 'Unknown animation');
  if (row.status !== 'draft') throw fail(409, 'already_uploaded', 'The file was already sent');
  if (c.now - row.created_at > DRAFT_TTL_MS) throw fail(410, 'draft_expired', 'This upload expired, start again');
  const length = Number(c.request.headers.get('Content-Length'));
  if (length !== row.size_bytes || !c.request.body) {
    throw fail(400, 'size_mismatch', 'The file size does not match what was declared');
  }

  await reserveStorage(c.env, row.size_bytes);
  try {
    await c.env.FILES.put(animationKey(id), c.request.body, {
      sha256: row.sha256,
      httpMetadata: { contentType: 'application/zip' },
    });
  } catch (err) {
    await releaseStorage(c.env, row.size_bytes);
    throw fail(400, 'checksum_mismatch', 'The file arrived damaged or does not match its hash, try again');
  }
  try {
    await c.env.DB.prepare("UPDATE animations SET status = 'scanning', updated_at = ? WHERE id = ? AND status = 'draft'")
      .bind(c.now, id)
      .run();
  } catch {
    // Someone else finished uploading the same file a moment earlier (unique hash).
    await c.env.FILES.delete(animationKey(id));
    await releaseStorage(c.env, row.size_bytes);
    throw fail(409, 'duplicate', 'This animation is already in the community');
  }
  await c.env.DB.batch(tagStatements(c.env.DB, id, JSON.parse(row.tags)));
  await queueJob(c, 'animation', id);
  return json({ id, status: 'scanning' }, 202);
}

const FEEDS = {
  new: { order: 'a.published_at DESC, a.id DESC', keys: ['published_at', 'id'], cmp: '(a.published_at, a.id) < (?, ?)' },
  top: { order: 'a.score DESC, a.id DESC', keys: ['score', 'id'], cmp: '(a.score, a.id) < (?, ?)' },
  trending: { order: 'a.trending DESC, a.id DESC', keys: ['trending', 'id'], cmp: '(a.trending, a.id) < (?, ?)' },
  featured: { order: 'a.featured_at DESC, a.id DESC', keys: ['featured_at', 'id'], cmp: '(a.featured_at, a.id) < (?, ?)' },
};

function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// GET /v1/animations?feed=new|top|trending|following&tag=&res=1080x2400&q=&cursor=&limit=
export async function list(c) {
  const params = c.url.searchParams;
  const feedName = params.get('feed') || 'trending';
  const following = feedName === 'following';
  const feed = following ? FEEDS.new : FEEDS[feedName];
  if (!feed) throw fail(400, 'invalid_feed', 'Unknown feed');
  const limit = Math.min(LIMITS.pageSizeMax, Math.max(1, Number(params.get('limit')) || LIMITS.pageSize));
  const where = ["a.status = 'published'", "o.status = 'active'"];
  const binds = [];

  if (feedName === 'featured') where.push('a.featured_at IS NOT NULL');
  if (following) {
    const viewer = await requireUser(c);
    where.push('a.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)');
    binds.push(viewer.id);
  }
  const tag = params.get('tag');
  if (tag) {
    const [clean] = cleanTags([tag], { max: 1, tagMax: LIMITS.tagMax });
    if (!clean) return json({ items: [], next_cursor: null });
    where.push('a.id IN (SELECT animation_id FROM animation_tags WHERE tag = ?)');
    binds.push(clean);
  }
  const res = params.get('res');
  if (res) {
    const match = /^(\d{2,5})x(\d{2,5})$/.exec(res);
    if (!match) throw fail(400, 'invalid_resolution', 'Resolution must look like 1080x2400');
    where.push('a.width = ? AND a.height = ?');
    binds.push(Number(match[1]), Number(match[2]));
  }
  const q = (params.get('q') || '').trim().slice(0, 60);
  if (q) {
    where.push("(a.title LIKE ? ESCAPE '\\' OR a.tags LIKE ? ESCAPE '\\')");
    binds.push(likePattern(q), likePattern(q.toLowerCase()));
  }
  const cursor = decodeCursor(params.get('cursor'), 2);
  if (cursor) {
    where.push(feed.cmp);
    binds.push(...cursor);
  }
  const rows = await c.env.DB.prepare(
    `SELECT a.*, ${OWNER_COLUMNS} FROM animations a JOIN users o ON o.id = a.owner_id
     WHERE ${where.join(' AND ')} ORDER BY ${feed.order} LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all();
  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  return json(
    {
      items: page.map((row) => animationCard(c.env, row)),
      next_cursor: rows.results.length > limit ? encodeCursor(feed.keys.map((key) => last[key])) : null,
    },
    200,
    following ? {} : { 'Cache-Control': 'public, max-age=30' },
  );
}

async function loadVisible(c, id, { allowOwner = true } = {}) {
  const row = await c.env.DB.prepare(
    `SELECT a.*, ${OWNER_COLUMNS}, o.status AS o_status FROM animations a JOIN users o ON o.id = a.owner_id WHERE a.id = ?`,
  )
    .bind(requireId(id, 'animation'))
    .first();
  if (!row) throw fail(404, 'not_found', 'Unknown animation');
  if (row.status === 'published' && row.o_status === 'active') return { row, viewer: await currentUser(c), public: true };
  const viewer = await currentUser(c);
  const allowed = viewer && (isModerator(viewer) || (allowOwner && viewer.id === row.owner_id));
  if (!allowed || row.status === 'removed' || (row.status === 'rejected' && !isModerator(viewer))) {
    throw fail(404, 'not_found', 'Unknown animation');
  }
  return { row, viewer, public: false };
}

export async function detail(c) {
  const { row, viewer } = await loadVisible(c, c.params.id);
  const extra = {};
  if (viewer) {
    const mine = await c.env.DB.prepare('SELECT stars FROM ratings WHERE animation_id = ? AND user_id = ?').bind(row.id, viewer.id).first();
    extra.my_rating = mine ? mine.stars : null;
    const follows = await c.env.DB.prepare('SELECT 1 AS yes FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(viewer.id, row.owner_id).first();
    extra.owner_followed_by_me = !!follows;
  }
  const remixes = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM animations WHERE remix_of = ? AND status = 'published'")
    .bind(row.id)
    .first();
  extra.remix_count = remixes.n;
  if (row.remix_of) {
    const source = await c.env.DB.prepare(
      `SELECT a.id, a.title, o.handle FROM animations a JOIN users o ON o.id = a.owner_id WHERE a.id = ? AND a.status = 'published'`,
    ).bind(row.remix_of).first();
    extra.remix_source = source ? { id: source.id, title: source.title, owner: source.handle } : null;
  }
  return json(animationDetail(c.env, row, viewer, extra));
}

export async function remixes(c) {
  await loadVisible(c, c.params.id);
  const rows = await c.env.DB.prepare(
    `SELECT a.*, ${OWNER_COLUMNS} FROM animations a JOIN users o ON o.id = a.owner_id
     WHERE a.remix_of = ? AND a.status = 'published' AND o.status = 'active' ORDER BY a.published_at DESC LIMIT ?`,
  ).bind(c.params.id, LIMITS.pageSizeMax).all();
  return json({ items: rows.results.map((row) => animationCard(c.env, row)) });
}

export async function mine(c) {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT a.*, ${OWNER_COLUMNS} FROM animations a JOIN users o ON o.id = a.owner_id
     WHERE a.owner_id = ? AND a.status NOT IN ('draft', 'removed') ORDER BY a.created_at DESC LIMIT 200`,
  ).bind(user.id).all();
  return json({ items: rows.results.map((row) => animationDetail(c.env, row, user)) });
}

export async function update(c) {
  const user = await requireUser(c);
  await rateLimit(c, 'profile', user.id, RATE.profileHour);
  const id = requireId(c.params.id, 'animation');
  const row = await c.env.DB.prepare('SELECT * FROM animations WHERE id = ? AND owner_id = ?').bind(id, user.id).first();
  if (!row || !STORED.has(row.status)) throw fail(404, 'not_found', 'Unknown animation');
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const fields = animationFields(body, row);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE animations SET title = ?, description = ?, tags = ?, license = ?, credits = ?, updated_at = ? WHERE id = ?')
      .bind(fields.title, fields.description, JSON.stringify(fields.tags), fields.license, JSON.stringify(fields.credits), c.now, id),
    ...tagStatements(c.env.DB, id, fields.tags),
  ]);
  // New text is checked again (same rules as on upload).
  if (fields.title !== row.title || fields.description !== row.description || JSON.stringify(fields.tags) !== row.tags) {
    await queueJob(c, 'animation', id);
  }
  return json({ ok: true });
}

export async function remove(c) {
  const user = await requireUser(c);
  const id = requireId(c.params.id, 'animation');
  const row = await c.env.DB.prepare('SELECT * FROM animations WHERE id = ? AND owner_id = ?').bind(id, user.id).first();
  if (!row || row.status === 'removed') throw fail(404, 'not_found', 'Unknown animation');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE animations SET status = 'removed', has_preview = 0, updated_at = ? WHERE id = ?").bind(c.now, id),
    c.env.DB.prepare("UPDATE cases SET status = 'closed', resolution = 'deleted_by_owner', updated_at = ? WHERE target_type = 'animation' AND target_id = ? AND status = 'open'")
      .bind(c.now, id),
    c.env.DB.prepare('DELETE FROM animation_tags WHERE animation_id = ?').bind(id),
    releaseStorageStatement(c.env, STORED.has(row.status) ? row.size_bytes : 0),
  ]);
  await c.env.FILES.delete([animationKey(id), previewKey(id)]);
  return json({ ok: true });
}

async function downloadSalt(env) {
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('download_salt', ?)").bind(randomToken(32)).run();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'download_salt'").first();
  return row.value;
}

// Counts one download per viewer, animation and day. Signed-in viewers count by account; others by a
// salted hash of the IP (the IP itself is never stored).
async function countDownload(c, row, viewer) {
  const day = utcDay(c.now);
  const viewerKey = viewer ? `u:${viewer.id}` : `ip:${await sha256Hex(`${await downloadSalt(c.env)}:${day}:${clientIp(c.request)}`)}`;
  const mark = await c.env.DB.prepare('INSERT OR IGNORE INTO download_marks (animation_id, day, viewer) VALUES (?, ?, ?)')
    .bind(row.id, day, viewerKey)
    .run();
  if (!mark.meta || mark.meta.changes !== 1) return;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE animations SET downloads = downloads + 1 WHERE id = ?').bind(row.id),
    c.env.DB.prepare(
      `INSERT INTO animation_daily (animation_id, day, downloads) VALUES (?, ?, 1)
       ON CONFLICT (animation_id, day) DO UPDATE SET downloads = downloads + 1`,
    ).bind(row.id, day),
  ]);
}

function fileName(title) {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'animation';
  return `${slug}-bootanimation.zip`;
}

export async function download(c) {
  const { row, viewer, public: isPublic } = await loadVisible(c, c.params.id);
  const object = await c.env.FILES.get(animationKey(row.id));
  if (!object) throw fail(404, 'not_found', 'File not available');
  if (isPublic && !(viewer && viewer.id === row.owner_id)) await countDownload(c, row, viewer);
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="${fileName(row.title)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Sha256': row.sha256,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function preview(c) {
  const { row, public: isPublic } = await loadVisible(c, c.params.id);
  const object = row.has_preview ? await c.env.FILES.get(previewKey(row.id)) : null;
  if (!object) throw fail(404, 'not_found', 'No preview');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(object.size),
      'Cache-Control': isPublic ? 'public, max-age=3600' : 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

export async function rate(c) {
  const viewer = await requireUser(c);
  await rateLimit(c, 'rating', viewer.id, RATE.ratingHour);
  const { row } = await loadVisible(c, c.params.id, { allowOwner: false });
  if (row.status !== 'published') throw fail(404, 'not_found', 'Unknown animation');
  if (row.owner_id === viewer.id) throw fail(400, 'own_animation', 'You cannot rate your own animation');
  const db = c.env.DB;
  let stars = null;
  if (c.request.method === 'DELETE') {
    await db.batch([db.prepare('DELETE FROM ratings WHERE animation_id = ? AND user_id = ?').bind(row.id, viewer.id), ratingRecompute(db, row.id)]);
  } else {
    const body = await readJson(c.request, LIMITS.jsonBodyBytes);
    stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw fail(400, 'invalid_stars', 'Stars must be 1 to 5');
    await db.batch([
      db.prepare(
        `INSERT INTO ratings (animation_id, user_id, stars, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (animation_id, user_id) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`,
      ).bind(row.id, viewer.id, stars, c.now),
      ratingRecompute(db, row.id),
    ]);
  }
  const fresh = await db.prepare('SELECT rating_sum, rating_count FROM animations WHERE id = ?').bind(row.id).first();
  return json({ my_rating: stars, rating: ratingOf(fresh) });
}
