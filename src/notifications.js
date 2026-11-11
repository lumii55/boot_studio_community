// Notifications: someone followed you, your upload was published or refused, someone published a remix of
// your animation. Created next to the change that causes them (same batch), listed newest first.

import { requireUser } from './auth.js';
import { LIMITS } from './config.js';
import { json } from './lib/http.js';
import { decodeCursor, encodeCursor, newId } from './lib/util.js';
import { userCard } from './views.js';

export function notifyStatement(c, { userId, kind, actorId = null, animationId = null, reason = '' }) {
  return c.env.DB.prepare(
    `INSERT INTO notifications (id, user_id, kind, actor_id, animation_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId(), userId, kind, actorId, animationId, String(reason).slice(0, 300), c.now);
}

// Statements for the first publication of an animation: tell its owner, and the original's owner for a remix.
export function publishedNotifications(c, row) {
  if (row.published_at) return []; // republished after a review of reports: nothing new to tell
  const statements = [notifyStatement(c, { userId: row.owner_id, kind: 'published', animationId: row.id })];
  if (row.remix_of) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, kind, actor_id, animation_id, reason, created_at)
       SELECT ?, owner_id, 'remix', ?, ?, '', ? FROM animations WHERE id = ? AND owner_id <> ?`,
    ).bind(newId(), row.owner_id, row.id, c.now, row.remix_of, row.owner_id));
  }
  return statements;
}

export async function list(c) {
  const user = await requireUser(c);
  const cursor = decodeCursor(c.url.searchParams.get('cursor'), 2);
  const rows = await c.env.DB.prepare(
    `SELECT n.*, n.rowid AS seq, u.handle AS a_handle, u.display_name AS a_display_name, u.avatar_media_id AS a_avatar_media_id,
            u.github_avatar_url AS a_github_avatar_url, an.title AS an_title, an.has_preview AS an_has_preview, an.status AS an_status
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     LEFT JOIN animations an ON an.id = n.animation_id
     WHERE n.user_id = ? ${cursor ? 'AND (n.created_at, n.rowid) < (?, ?)' : ''}
     ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`,
  ).bind(user.id, ...(cursor || []), LIMITS.pageSize + 1).all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const last = page[page.length - 1];
  return json({
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      read: !!row.read_at,
      created_at: row.created_at,
      reason: row.reason,
      actor: row.a_handle ? userCard(c.env, row, 'a_') : null,
      animation: row.animation_id && row.an_title ? {
        id: row.animation_id,
        title: row.an_title,
        status: row.an_status,
        preview_url: row.an_has_preview ? new URL(`/v1/animations/${row.animation_id}/preview`, c.env.PUBLIC_URL).href : null,
      } : null,
    })),
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor([last.created_at, last.seq]) : null,
  });
}

export async function unread(c) {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id).first();
  return json({ unread: row.n });
}

export async function markRead(c) {
  const user = await requireUser(c);
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(c.now, user.id).run();
  return json({ ok: true });
}
