// Panel tools beyond the report queues: overview (storage, numbers, pause uploads), people and animations.

import { requireModerator, requireOwner } from './auth.js';
import { LIMITS } from './config.js';
import { fail, json, readJson } from './lib/http.js';
import { cleanText, decodeCursor, encodeCursor, HANDLE_RE, requireId } from './lib/util.js';
import { logAction } from './moderation.js';
import { notifyStatement, publishedNotifications } from './notifications.js';
import { ANIMATION_ACTION_PERMISSION, can, requirePermission } from './permissions.js';
import { queueJob } from './pipeline.js';
import { applySanction, revokeSanction } from './sanctions.js';
import { animationKey, previewKey, releaseStorageStatement, storageStatus } from './storage.js';
import { animationCard, OWNER_COLUMNS } from './views.js';

const DAY = 86400000;

export async function stats(c) {
  await requireModerator(c);
  const db = c.env.DB;
  const since = c.now - 7 * DAY;
  const [storage, users, animations, cases, extra] = await Promise.all([
    storageStatus(c.env),
    db.prepare(`SELECT COUNT(*) AS total, SUM(created_at >= ?) AS new_7d, SUM(status = 'banned') AS banned FROM users`).bind(since).first(),
    db.prepare('SELECT status, COUNT(*) AS n FROM animations GROUP BY status').all(),
    db.prepare(`SELECT SUM(mass = 1) AS mass, SUM(mass = 0 AND report_count > 0) AS reports, SUM(mass = 0 AND report_count = 0) AS review
                FROM cases WHERE status = 'open'`).first(),
    db.prepare(`SELECT
        (SELECT COALESCE(SUM(downloads), 0) FROM animations) AS downloads,
        (SELECT COUNT(*) FROM reports WHERE created_at >= ?1) AS reports_7d,
        (SELECT COUNT(*) FROM pipeline_jobs WHERE status IN ('queued', 'dispatched', 'running')) AS checks_running,
        (SELECT COUNT(*) FROM pipeline_jobs WHERE status = 'failed' AND updated_at >= ?1) AS checks_failed_7d,
        (SELECT COUNT(*) FROM animations WHERE featured_at IS NOT NULL AND status = 'published') AS featured`).bind(since).first(),
  ]);
  const byStatus = Object.fromEntries(animations.results.map((row) => [row.status, row.n]));
  return json({
    storage: { used_bytes: storage.used, limit_bytes: storage.limit, paused: storage.paused },
    users: { total: users.total || 0, new_7d: users.new_7d || 0, banned: users.banned || 0 },
    animations: {
      published: byStatus.published || 0, review: byStatus.review || 0, scanning: byStatus.scanning || 0,
      hidden: byStatus.hidden || 0, rejected: byStatus.rejected || 0, featured: extra.featured || 0,
    },
    open_cases: { mass: cases.mass || 0, reports: cases.reports || 0, review: cases.review || 0 },
    downloads: extra.downloads || 0,
    reports_7d: extra.reports_7d || 0,
    checks: { running: extra.checks_running || 0, failed_7d: extra.checks_failed_7d || 0 },
  });
}

export async function setUploadsPaused(c) {
  const owner = await requireOwner(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  if (typeof body.paused !== 'boolean') throw fail(400, 'invalid_field', 'paused must be true or false');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'uploads_paused'").bind(body.paused ? '1' : '0'),
    logAction(c, { targetType: 'user', targetId: owner.id, actorId: owner.id, source: 'panel', action: body.paused ? 'uploads_paused' : 'uploads_resumed' }),
  ]);
  return json({ paused: body.paused });
}

function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listUsers(c) {
  await requireModerator(c);
  const q = (c.url.searchParams.get('q') || '').trim().replace(/^@/, '').slice(0, 40);
  const filter = c.url.searchParams.get('filter') || 'all';
  const where = [];
  const binds = [];
  if (q) {
    where.push("(u.handle LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
    binds.push(likePattern(q.toLowerCase()), likePattern(q));
  }
  if (filter === 'banned') where.push("u.status = 'banned'");
  else if (filter === 'team') where.push("u.role <> 'user'");
  else if (filter === 'new') where.push('u.trust = 0');
  const cursor = decodeCursor(c.url.searchParams.get('cursor'), 2);
  if (cursor) {
    where.push('(u.created_at, u.id) < (?, ?)');
    binds.push(...cursor);
  }
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.handle, u.display_name, u.role, u.status, u.trust, u.created_at, u.github_created_at,
            u.avatar_media_id, u.github_avatar_url,
            (SELECT COUNT(*) FROM animations a WHERE a.owner_id = u.id AND a.status = 'published') AS published,
            (SELECT COUNT(*) FROM animations a WHERE a.owner_id = u.id AND a.status = 'rejected') AS refused
     FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
  ).bind(...binds, LIMITS.pageSize + 1).all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const last = page[page.length - 1];
  return json({
    items: page.map(({ id, avatar_media_id, github_avatar_url, ...row }) => ({
      ...row,
      avatar_url: avatar_media_id ? new URL(`/v1/media/${avatar_media_id}`, c.env.PUBLIC_URL).href : github_avatar_url || null,
    })),
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor([last.created_at, last.id]) : null,
  });
}

const USER_ACTIONS = new Set(['ban', 'unban', 'trust', 'untrust', 'clear_profile']);

// Shortcuts kept from the first panel: ban/unban are punishments like any other; trust is a setting of the person.
export async function userAction(c) {
  const actor = await requireModerator(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const action = String(body.action || '');
  if (!USER_ACTIONS.has(action)) throw fail(400, 'invalid_action', 'Unknown action');
  const reason = cleanText(body.reason, { field: 'reason', max: LIMITS.reasonMax, multiline: true });
  const target = await personByHandle(c, c.params.handle);
  if (action === 'ban') {
    await applySanction(c, actor, target, { kind: 'ban', reason: reason || 'Banned', days: null, restrictions: [], hideUploads: false });
    return json({ ok: true });
  }
  if (action === 'unban') {
    requirePermission(actor, 'ban');
    const bans = await c.env.DB.prepare("SELECT id FROM sanctions WHERE user_id = ? AND kind = 'ban' AND revoked_at IS NULL").bind(target.id).all();
    for (const ban of bans.results) await revokeSanction(c, actor, ban.id, reason);
    if (!bans.results.length && target.status === 'banned') {
      // Banned before punishments existed: lift it directly.
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").bind(c.now, target.id),
        c.env.DB.prepare("UPDATE animations SET status = CASE WHEN published_at IS NULL THEN 'review' ELSE 'published' END, status_reason = '', updated_at = ? WHERE owner_id = ? AND status = 'hidden' AND status_reason = 'Account banned'")
          .bind(c.now, target.id),
        logAction(c, { targetType: 'user', targetId: target.id, actorId: actor.id, source: 'panel', action: 'revoke_ban', reason }),
      ]);
    }
    return json({ ok: true });
  }
  if (action === 'clear_profile') {
    requirePermission(actor, 'clear_profile');
    if (target.id === actor.id || target.role === 'owner') throw fail(403, 'forbidden', 'Not on this person');
    if (target.role === 'moderator' && actor.role !== 'owner') throw fail(403, 'forbidden', 'Only the owner can act on moderators');
    const media = await c.env.DB.prepare('SELECT id, size_bytes FROM media WHERE owner_id = ?').bind(target.id).all();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET display_name = handle, bio = '', links = '[]', avatar_media_id = NULL, banner_media_id = NULL, updated_at = ?
                        WHERE id = ?`).bind(c.now, target.id),
      c.env.DB.prepare('DELETE FROM media WHERE owner_id = ?').bind(target.id),
      releaseStorageStatement(c.env, media.results.reduce((sum, item) => sum + item.size_bytes, 0)),
      logAction(c, { targetType: 'user', targetId: target.id, actorId: actor.id, source: 'panel', action: 'clear_profile', reason }),
    ]);
    if (media.results.length) await c.env.FILES.delete(media.results.map((item) => `media/${item.id}`));
    return json({ ok: true });
  }
  requirePermission(actor, 'trust');
  if (target.id === actor.id || target.role === 'owner') throw fail(403, 'forbidden', 'Not on this person');
  if (target.role === 'moderator' && actor.role !== 'owner') throw fail(403, 'forbidden', 'Only the owner can act on moderators');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET trust = ?, updated_at = ? WHERE id = ?').bind(action === 'trust' ? 1 : 0, c.now, target.id),
    logAction(c, { targetType: 'user', targetId: target.id, actorId: actor.id, source: 'panel', action: `user_${action}`, reason }),
  ]);
  return json({ ok: true });
}

async function personByHandle(c, raw) {
  const handle = String(raw || '').toLowerCase();
  if (!HANDLE_RE.test(handle)) throw fail(404, 'not_found', 'Unknown user');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle).first();
  if (!user) throw fail(404, 'not_found', 'Unknown user');
  return user;
}

const ANIMATION_STATUSES = new Set(['published', 'review', 'scanning', 'hidden', 'rejected', 'featured']);

export async function listAnimations(c) {
  await requireModerator(c);
  const status = c.url.searchParams.get('status') || 'published';
  if (!ANIMATION_STATUSES.has(status)) throw fail(400, 'invalid_field', 'Unknown status');
  const q = (c.url.searchParams.get('q') || '').trim().slice(0, 60);
  const where = status === 'featured' ? ["a.status = 'published'", 'a.featured_at IS NOT NULL'] : ['a.status = ?'];
  const binds = status === 'featured' ? [] : [status];
  if (q) {
    where.push("(a.title LIKE ? ESCAPE '\\' OR o.handle LIKE ? ESCAPE '\\')");
    binds.push(likePattern(q), likePattern(q.toLowerCase().replace(/^@/, '')));
  }
  const cursor = decodeCursor(c.url.searchParams.get('cursor'), 2);
  if (cursor) {
    where.push('(a.updated_at, a.id) < (?, ?)');
    binds.push(...cursor);
  }
  const rows = await c.env.DB.prepare(
    `SELECT a.*, ${OWNER_COLUMNS} FROM animations a JOIN users o ON o.id = a.owner_id
     WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
  ).bind(...binds, LIMITS.pageSize + 1).all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const last = page[page.length - 1];
  return json({
    items: page.map((row) => ({ ...animationCard(c.env, row), status: row.status, status_reason: row.status_reason, featured: !!row.featured_at })),
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor([last.updated_at, last.id]) : null,
  });
}

const ANIMATION_ACTIONS = new Set(['hide', 'restore', 'remove', 'recheck', 'feature', 'unfeature']);

export async function animationAction(c) {
  const actor = await requireModerator(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const action = String(body.action || '');
  if (!ANIMATION_ACTIONS.has(action)) throw fail(400, 'invalid_action', 'Unknown action');
  requirePermission(actor, ANIMATION_ACTION_PERMISSION[action]);
  const reason = cleanText(body.reason, { field: 'reason', max: LIMITS.reasonMax, multiline: true });
  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM animations WHERE id = ?').bind(requireId(c.params.id, 'animation')).first();
  if (!row || row.status === 'removed' || row.status === 'draft') throw fail(404, 'not_found', 'Unknown animation');
  const log = logAction(c, { targetType: 'animation', targetId: row.id, actorId: actor.id, source: 'panel', action, reason });
  const allowed = {
    hide: ['published', 'review'],
    restore: ['hidden', 'review'],
    remove: ['published', 'review', 'hidden', 'scanning'],
    recheck: ['published', 'review', 'hidden'],
    feature: ['published'],
    unfeature: ['published', 'hidden'],
  }[action];
  if (!allowed.includes(row.status)) throw fail(409, 'invalid_state', 'Not possible in the current state');

  if (action === 'hide') {
    await db.batch([db.prepare("UPDATE animations SET status = 'hidden', status_reason = ?, updated_at = ? WHERE id = ?")
      .bind(reason || 'Hidden by a moderator', c.now, row.id), log]);
  } else if (action === 'restore') {
    await db.batch([
      db.prepare(`UPDATE animations SET status = 'published', status_reason = '', published_at = COALESCE(published_at, ?), updated_at = ?
                  WHERE id = ?`).bind(c.now, c.now, row.id),
      ...publishedNotifications(c, row),
      db.prepare("UPDATE cases SET status = 'closed', resolution = 'approve', updated_at = ? WHERE target_type = 'animation' AND target_id = ? AND status = 'open'")
        .bind(c.now, row.id),
      log,
    ]);
  } else if (action === 'remove') {
    await db.batch([
      db.prepare("UPDATE animations SET status = 'rejected', status_reason = ?, has_preview = 0, featured_at = NULL, updated_at = ? WHERE id = ?")
        .bind(reason || 'Removed by a moderator', c.now, row.id),
      releaseStorageStatement(c.env, row.size_bytes),
      notifyStatement(c, { userId: row.owner_id, kind: 'refused', animationId: row.id, reason: reason || '' }),
      db.prepare("UPDATE cases SET status = 'closed', resolution = 'remove', updated_at = ? WHERE target_type = 'animation' AND target_id = ? AND status = 'open'")
        .bind(c.now, row.id),
      log,
    ]);
    await c.env.FILES.delete([animationKey(row.id), previewKey(row.id)]);
  } else if (action === 'recheck') {
    await log.run();
    await queueJob(c, 'animation', row.id);
  } else {
    await db.batch([db.prepare('UPDATE animations SET featured_at = ? WHERE id = ?').bind(action === 'feature' ? c.now : null, row.id), log]);
  }
  return json({ ok: true });
}
