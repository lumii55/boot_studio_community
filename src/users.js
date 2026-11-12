// Profiles, profile images, follows and account deletion.

import { currentUser, isModerator, requireUser } from './auth.js';
import { LIMITS, RATE, RATING_PRIOR_MEAN as RATING_MEAN, RATING_PRIOR_WEIGHT as RATING_WEIGHT } from './config.js';
import { fail, json, readBytes, readJson } from './lib/http.js';
import { sniffImage } from './lib/images.js';
import { rateLimit } from './lib/ratelimit.js';
import { personSearchText } from './lib/search.js';
import { cleanLinks, cleanText, decodeCursor, encodeCursor, HANDLE_RE, newId, requireId } from './lib/util.js';
import { notifyStatement } from './notifications.js';
import { queueJob } from './pipeline.js';
import { assertAllowed } from './sanctions.js';
import { animationKey, mediaKey, previewKey, releaseStorageStatement, reserveStorage } from './storage.js';
import { animationCard, OWNER_COLUMNS, ownProfile, publicProfile, userCard } from './views.js';

async function pendingMedia(env, userId) {
  const rows = await env.DB.prepare("SELECT id, kind FROM media WHERE owner_id = ? AND status = 'pending' ORDER BY created_at DESC")
    .bind(userId)
    .all();
  const pending = {};
  for (const row of rows.results) if (!pending[row.kind]) pending[row.kind] = row.id;
  return pending;
}

export async function me(c) {
  const user = await requireUser(c);
  return json(ownProfile(c.env, user, await pendingMedia(c.env, user.id)));
}

export async function updateProfile(c) {
  const user = await requireUser(c);
  await assertAllowed(c, user, 'profile');
  await rateLimit(c, 'profile', user.id, RATE.profileHour);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const next = {
    display_name: body.display_name === undefined ? user.display_name
      : cleanText(body.display_name, { field: 'display_name', min: 1, max: LIMITS.displayNameMax }),
    bio: body.bio === undefined ? user.bio : cleanText(body.bio, { field: 'bio', max: LIMITS.bioMax, multiline: true }),
    links: body.links === undefined ? user.links : JSON.stringify(cleanLinks(body.links, LIMITS)),
  };
  await c.env.DB.prepare('UPDATE users SET display_name = ?, bio = ?, links = ?, search_name = ?, updated_at = ? WHERE id = ?')
    .bind(next.display_name, next.bio, next.links, personSearchText({ handle: user.handle, display_name: next.display_name }), c.now, user.id)
    .run();
  const textChanged = next.display_name !== user.display_name || next.bio !== user.bio || next.links !== user.links;
  // Text is visible right away and checked afterwards (never punished automatically).
  if (textChanged) await queueJob(c, 'profile', user.id);
  const fresh = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return json(ownProfile(c.env, fresh, await pendingMedia(c.env, user.id)));
}

const MEDIA_RULES = {
  avatar: (image) => image.width <= LIMITS.avatarMaxSide && image.height <= LIMITS.avatarMaxSide,
  banner: (image) => image.width <= LIMITS.bannerMaxWidth && image.height <= LIMITS.bannerMaxHeight,
};

// PUT /v1/me/avatar and /v1/me/banner. The new image is shown to its owner at once and to everyone
// else after the automatic check approves it.
export async function uploadMedia(c) {
  const user = await requireUser(c);
  const kind = c.params.kind;
  if (!MEDIA_RULES[kind]) throw fail(404, 'not_found', 'Unknown image kind');
  await assertAllowed(c, user, 'profile');
  await rateLimit(c, 'media', user.id, RATE.mediaHour);
  const max = kind === 'avatar' ? LIMITS.avatarBytes : LIMITS.bannerBytes;
  const bytes = await readBytes(c.request, max);
  const image = sniffImage(bytes);
  if (!image || image.width < 1 || image.height < 1 || !MEDIA_RULES[kind](image)) {
    throw fail(400, 'invalid_image', 'Use a PNG, JPEG or WebP image within the size limits', { details: { kind } });
  }
  await reserveStorage(c.env, bytes.byteLength);
  const id = newId();
  await c.env.FILES.put(mediaKey(id), bytes, { httpMetadata: { contentType: image.type } });

  // Replace an older pending image of the same kind.
  const older = await c.env.DB.prepare("SELECT id, size_bytes FROM media WHERE owner_id = ? AND kind = ? AND status = 'pending'")
    .bind(user.id, kind)
    .all();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO media (id, owner_id, kind, content_type, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    ).bind(id, user.id, kind, image.type, bytes.byteLength, c.now),
    ...older.results.flatMap((row) => [
      c.env.DB.prepare('DELETE FROM media WHERE id = ?').bind(row.id),
      releaseStorageStatement(c.env, row.size_bytes),
    ]),
  ]);
  if (older.results.length) await c.env.FILES.delete(older.results.map((row) => mediaKey(row.id)));
  await queueJob(c, 'media', id);
  return json({ id, status: 'pending' }, 202);
}

export async function deleteMedia(c) {
  const user = await requireUser(c);
  await assertAllowed(c, user, 'profile');
  const kind = c.params.kind;
  if (!MEDIA_RULES[kind]) throw fail(404, 'not_found', 'Unknown image kind');
  const rows = await c.env.DB.prepare('SELECT id, size_bytes FROM media WHERE owner_id = ? AND kind = ?').bind(user.id, kind).all();
  const column = kind === 'avatar' ? 'avatar_media_id' : 'banner_media_id';
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET ${column} = NULL, updated_at = ? WHERE id = ?`).bind(c.now, user.id),
    ...rows.results.flatMap((row) => [
      c.env.DB.prepare('DELETE FROM media WHERE id = ?').bind(row.id),
      releaseStorageStatement(c.env, row.size_bytes),
    ]),
  ]);
  if (rows.results.length) await c.env.FILES.delete(rows.results.map((row) => mediaKey(row.id)));
  return json({ ok: true });
}

export async function getMedia(c) {
  const id = requireId(c.params.id, 'image');
  const row = await c.env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first();
  if (!row) throw fail(404, 'not_found', 'Unknown image');
  if (row.status !== 'approved') {
    const viewer = await currentUser(c);
    if (!viewer || (viewer.id !== row.owner_id && !isModerator(viewer))) throw fail(404, 'not_found', 'Unknown image');
  }
  const object = await c.env.FILES.get(mediaKey(id));
  if (!object) throw fail(404, 'not_found', 'Unknown image');
  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type,
      'Content-Length': String(object.size),
      // Media IDs are never reused, so approved images can be cached for good.
      'Cache-Control': row.status === 'approved' ? 'public, max-age=31536000, immutable' : 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

async function userByHandle(c, raw) {
  const handle = String(raw || '').toLowerCase();
  if (!HANDLE_RE.test(handle)) throw fail(404, 'not_found', 'Unknown user');
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE handle = ? AND status = 'active'").bind(handle).first();
  if (!user) throw fail(404, 'not_found', 'Unknown user');
  return user;
}

export async function getProfile(c) {
  const user = await userByHandle(c, c.params.handle);
  const viewer = await currentUser(c);
  const counts = await c.env.DB.prepare(
    "SELECT COUNT(*) AS animations, COALESCE(SUM(downloads), 0) AS downloads FROM animations WHERE owner_id = ? AND status = 'published'",
  ).bind(user.id).first();
  let following = false;
  if (viewer && viewer.id !== user.id) {
    following = !!(await c.env.DB.prepare('SELECT 1 AS yes FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(viewer.id, user.id)
      .first());
  }
  return json(publicProfile(c.env, user, viewer, {
    animations: counts.animations,
    total_downloads: counts.downloads,
    followed_by_me: following,
  }));
}

export async function profileAnimations(c) {
  const user = await userByHandle(c, c.params.handle);
  const cursor = decodeCursor(c.url.searchParams.get('cursor'), 2);
  const rows = await c.env.DB.prepare(
    `SELECT a.*, ${OWNER_COLUMNS} FROM animations a JOIN users o ON o.id = a.owner_id
     WHERE a.owner_id = ? AND a.status = 'published' ${cursor ? 'AND (a.published_at, a.id) < (?, ?)' : ''}
     ORDER BY a.published_at DESC, a.id DESC LIMIT ?`,
  )
    .bind(user.id, ...(cursor || []), LIMITS.pageSize + 1)
    .all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const last = page[page.length - 1];
  return json({
    items: page.map((row) => animationCard(c.env, row)),
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor([last.published_at, last.id]) : null,
  });
}

export async function followList(c) {
  const user = await userByHandle(c, c.params.handle);
  const which = c.params.which;
  if (which !== 'followers' && which !== 'following') throw fail(404, 'not_found', 'Unknown list');
  const [joinColumn, whereColumn] = which === 'followers' ? ['follower_id', 'followee_id'] : ['followee_id', 'follower_id'];
  const cursor = decodeCursor(c.url.searchParams.get('cursor'), 2);
  const rows = await c.env.DB.prepare(
    `SELECT u.*, f.created_at AS followed_at FROM follows f JOIN users u ON u.id = f.${joinColumn}
     WHERE f.${whereColumn} = ? AND u.status = 'active' ${cursor ? 'AND (f.created_at, u.id) < (?, ?)' : ''}
     ORDER BY f.created_at DESC, u.id DESC LIMIT ?`,
  )
    .bind(user.id, ...(cursor || []), LIMITS.pageSize + 1)
    .all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const last = page[page.length - 1];
  return json({
    items: page.map((row) => userCard(c.env, row)),
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor([last.followed_at, last.id]) : null,
  });
}

function followCountStatements(db, ids) {
  return ids.flatMap((id) => [
    db.prepare(
      `UPDATE users SET followers_count = (SELECT COUNT(*) FROM follows WHERE followee_id = ?),
         following_count = (SELECT COUNT(*) FROM follows WHERE follower_id = ?) WHERE id = ?`,
    ).bind(id, id, id),
  ]);
}

export async function follow(c) {
  const viewer = await requireUser(c);
  const target = await userByHandle(c, c.params.handle);
  if (target.id === viewer.id) throw fail(400, 'invalid_follow', 'You cannot follow yourself');
  await rateLimit(c, 'follow', viewer.id, RATE.followHour);
  const db = c.env.DB;
  const statement = c.request.method === 'PUT'
    ? db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').bind(viewer.id, target.id, c.now)
    : db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(viewer.id, target.id);
  const [changed] = await db.batch([statement, ...followCountStatements(db, [viewer.id, target.id])]);
  if (c.request.method === 'PUT' && changed.meta && changed.meta.changes === 1) {
    // One "followed you" per person: following again after unfollowing replaces the old notice.
    await db.batch([
      db.prepare("DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND kind = 'follow'").bind(target.id, viewer.id),
      notifyStatement(c, { userId: target.id, kind: 'follow', actorId: viewer.id }),
    ]);
  }
  const fresh = await db.prepare('SELECT followers_count FROM users WHERE id = ?').bind(target.id).first();
  return json({ following: c.request.method === 'PUT', followers: fresh.followers_count });
}

// DELETE /v1/me: removes the account, its files, ratings and follows. Reports and moderation history
// keep only the anonymous record. Requires {"confirm": "<handle>"}.
export async function deleteAccount(c) {
  const user = await requireUser(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  if (body.confirm !== user.handle) throw fail(400, 'confirm_required', 'Type your handle to confirm');
  if (user.role === 'owner') throw fail(403, 'forbidden', 'The owner account cannot be deleted here');
  const db = c.env.DB;
  const animations = await db.prepare('SELECT id, size_bytes, status FROM animations WHERE owner_id = ?').bind(user.id).all();
  const media = await db.prepare('SELECT id, size_bytes FROM media WHERE owner_id = ?').bind(user.id).all();
  const rated = await db.prepare('SELECT animation_id FROM ratings WHERE user_id = ?').bind(user.id).all();
  const followRows = await db.prepare(
    'SELECT followee_id AS id FROM follows WHERE follower_id = ? UNION SELECT follower_id FROM follows WHERE followee_id = ?',
  ).bind(user.id, user.id).all();
  const stored = animations.results.filter((row) => !['rejected', 'removed', 'draft'].includes(row.status));
  const freed = stored.reduce((sum, row) => sum + row.size_bytes, 0) + media.results.reduce((sum, row) => sum + row.size_bytes, 0);

  await db.batch([
    // Open cases about this account's things have nothing left to decide.
    db.prepare(
      `UPDATE cases SET status = 'closed', resolution = 'account_deleted', updated_at = ?1 WHERE status = 'open' AND (
         (target_type = 'user' AND target_id = ?2)
         OR (target_type = 'animation' AND target_id IN (SELECT id FROM animations WHERE owner_id = ?2))
         OR (target_type = 'media' AND target_id IN (SELECT id FROM media WHERE owner_id = ?2)))`,
    ).bind(c.now, user.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id), // cascades: sessions, media, animations, ratings, follows
    releaseStorageStatement(c.env, freed),
    ...rated.results.map((row) => ratingRecompute(db, row.animation_id)),
    ...followCountStatements(db, followRows.results.map((row) => row.id)),
  ]);
  const keys = [
    ...animations.results.flatMap((row) => [animationKey(row.id), previewKey(row.id)]),
    ...media.results.map((row) => mediaKey(row.id)),
  ];
  for (let i = 0; i < keys.length; i += 1000) await c.env.FILES.delete(keys.slice(i, i + 1000));
  return json({ ok: true });
}

export function ratingRecompute(db, animationId) {
  return db.prepare(
    `UPDATE animations SET
       rating_sum = (SELECT COALESCE(SUM(stars), 0) FROM ratings WHERE animation_id = ?1),
       rating_count = (SELECT COUNT(*) FROM ratings WHERE animation_id = ?1),
       score = (?2 * ?3 + (SELECT COALESCE(SUM(stars), 0) FROM ratings WHERE animation_id = ?1))
             / (?2 + (SELECT COUNT(*) FROM ratings WHERE animation_id = ?1))
     WHERE id = ?1`,
  ).bind(animationId, RATING_WEIGHT, RATING_MEAN);
}

