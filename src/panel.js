// Panel, second round: person file, punishments, internal notes, abusive reporters, charts, bulk decisions,
// announcement, re-check everything, community settings and the LGPD data export.

import { requireModerator, requireOwner } from './auth.js';
import { LIMITS } from './config.js';
import { notifyCase } from './discord.js';
import { fail, json, readJson } from './lib/http.js';
import { cleanText, HANDLE_RE, newId, requireId, utcDay } from './lib/util.js';
import { logAction, performCaseAction } from './moderation.js';
import { can, permissionsOf, requirePermission } from './permissions.js';
import { applySanction, cleanSanction, revokeSanction, strikes, STRIKE_WINDOW_DAYS, suggestion } from './sanctions.js';
import { cleanSettings, getSettings, saveSettingsStatement } from './settings.js';
import { mediaUrl } from './views.js';

const DAY = 86400000;

async function personByHandle(c, raw) {
  const handle = String(raw || '').toLowerCase().replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) throw fail(404, 'not_found', 'Unknown user');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle).first();
  if (!user) throw fail(404, 'not_found', 'Unknown user');
  return user;
}

function sanctionView(row) {
  return {
    id: row.id,
    kind: row.kind,
    restrictions: JSON.parse(row.restrictions || '[]'),
    hide_uploads: !!row.hide_uploads,
    reason: row.reason,
    actor: row.actor_handle || null,
    created_at: row.created_at,
    ends_at: row.ends_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoker_handle || null,
  };
}

const isActive = (row, now) => !row.revoked_at && (row.kind === 'ban' || (row.kind !== 'warning' && (!row.ends_at || row.ends_at > now)));

// GET /v1/mod/users/:handle — everything the team needs to decide about one person.
export async function personFile(c) {
  const viewer = await requireModerator(c);
  const user = await personByHandle(c, c.params.handle);
  const db = c.env.DB;
  const [animations, made, received, sanctions, notes, strikeCount] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(downloads), 0) AS downloads FROM animations WHERE owner_id = ? AND status <> 'draft' GROUP BY status").bind(user.id).all(),
    db.prepare(`SELECT COUNT(*) AS total,
                  SUM(CASE WHEN cs.status = 'closed' AND cs.resolution IN ('approve', 'dismiss') THEN 1 ELSE 0 END) AS unfounded,
                  SUM(CASE WHEN cs.status = 'closed' AND cs.resolution NOT IN ('approve', 'dismiss') THEN 1 ELSE 0 END) AS upheld
                FROM reports r JOIN cases cs ON cs.id = r.case_id WHERE r.reporter_id = ?`).bind(user.id).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM reports r WHERE (r.target_type = 'user' AND r.target_id = ?)
                OR (r.target_type = 'animation' AND r.target_id IN (SELECT id FROM animations WHERE owner_id = ?))`).bind(user.id, user.id).first(),
    db.prepare(`SELECT s.*, a.handle AS actor_handle, rv.handle AS revoker_handle FROM sanctions s
                LEFT JOIN users a ON a.id = s.actor_id LEFT JOIN users rv ON rv.id = s.revoked_by
                WHERE s.user_id = ? ORDER BY s.created_at DESC, s.rowid DESC`).bind(user.id).all(),
    notesFor(c, 'user', user.id),
    strikes(c, user.id),
  ]);
  const byStatus = Object.fromEntries(animations.results.map((row) => [row.status, row.n]));
  const active = sanctions.results.filter((row) => isActive(row, c.now));
  return json({
    handle: user.handle,
    display_name: user.display_name,
    avatar_url: mediaUrl(c.env, user.avatar_media_id) || user.github_avatar_url || null,
    bio: user.bio,
    role: user.role,
    permissions: permissionsOf(user),
    status: user.status,
    suspended_until: user.suspended_until && user.suspended_until > c.now ? user.suspended_until : null,
    trust: user.trust,
    joined_at: user.created_at,
    github_created_at: user.github_created_at,
    followers: user.followers_count,
    animations: {
      published: byStatus.published || 0, review: byStatus.review || 0, hidden: byStatus.hidden || 0, refused: byStatus.rejected || 0,
      downloads: animations.results.reduce((sum, row) => sum + row.downloads, 0),
    },
    reports_made: { total: made.total || 0, unfounded: made.unfounded || 0, upheld: made.upheld || 0 },
    reports_received: received.n,
    strikes: { count: strikeCount, window_days: STRIKE_WINDOW_DAYS, suggestion: suggestion(strikeCount, active) },
    sanctions: sanctions.results.map((row) => ({ ...sanctionView(row), active: isActive(row, c.now) })),
    notes,
    can: {
      act: user.role !== 'owner' && user.id !== viewer.id && (user.role !== 'moderator' || viewer.role === 'owner'),
      export: can(viewer, 'export'),
    },
  });
}

export async function createSanction(c) {
  const actor = await requireModerator(c);
  const target = await personByHandle(c, c.params.handle);
  const input = cleanSanction(await readJson(c.request, LIMITS.jsonBodyBytes));
  const id = await applySanction(c, actor, target, input);
  return json({ id }, 201);
}

export async function liftSanction(c) {
  const actor = await requireModerator(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  await revokeSanction(c, actor, requireId(c.params.id, 'punishment'), cleanText(body.reason, { field: 'reason', max: 500, multiline: true }));
  return json({ ok: true });
}

// ---------------------------------------------------------------- internal notes

async function notesFor(c, targetType, targetId) {
  const rows = await c.env.DB.prepare(
    `SELECT n.id, n.body, n.created_at, u.handle AS author, n.author_id FROM mod_notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.target_type = ? AND n.target_id = ? ORDER BY n.created_at DESC, n.rowid DESC LIMIT 100`,
  ).bind(targetType, targetId).all();
  return rows.results.map(({ author_id, ...row }) => ({ ...row, mine: author_id === (c.user && c.user.id) }));
}

async function noteTarget(c, type, raw) {
  if (type === 'user') return (await personByHandle(c, raw)).id;
  if (type === 'case') {
    const row = await c.env.DB.prepare('SELECT id FROM cases WHERE id = ?').bind(requireId(raw, 'case')).first();
    if (!row) throw fail(404, 'not_found', 'Unknown case');
    return row.id;
  }
  throw fail(400, 'invalid_target', 'Notes are for people or cases');
}

export async function listNotes(c) {
  await requireModerator(c);
  const type = c.url.searchParams.get('target_type');
  const id = await noteTarget(c, type, c.url.searchParams.get('target_id'));
  return json({ items: await notesFor(c, type, id) });
}

export async function addNote(c) {
  const author = await requireModerator(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const id = await noteTarget(c, body.target_type, body.target_id);
  const text = cleanText(body.body, { field: 'body', min: 1, max: 1000, multiline: true });
  await c.env.DB.prepare('INSERT INTO mod_notes (id, target_type, target_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId(), body.target_type, id, author.id, text, c.now).run();
  return json({ items: await notesFor(c, body.target_type, id) }, 201);
}

export async function deleteNote(c) {
  const viewer = await requireModerator(c);
  const note = await c.env.DB.prepare('SELECT * FROM mod_notes WHERE id = ?').bind(requireId(c.params.id, 'note')).first();
  if (!note) throw fail(404, 'not_found', 'Unknown note');
  if (note.author_id !== viewer.id && viewer.role !== 'owner') throw fail(403, 'forbidden', 'Only the author or the owner can delete a note');
  await c.env.DB.prepare('DELETE FROM mod_notes WHERE id = ?').bind(note.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- abusive reporters, charts

// People whose reports are mostly unfounded (content kept after review) in the last 12 months.
export async function reporters(c) {
  await requireModerator(c);
  const rows = await c.env.DB.prepare(
    `SELECT u.handle, u.display_name, COUNT(*) AS total,
            SUM(CASE WHEN cs.resolution IN ('approve', 'dismiss') THEN 1 ELSE 0 END) AS unfounded
     FROM reports r JOIN cases cs ON cs.id = r.case_id JOIN users u ON u.id = r.reporter_id
     WHERE r.created_at >= ? AND cs.status = 'closed'
     GROUP BY r.reporter_id HAVING total >= 5 AND unfounded * 1.0 / total >= 0.7
     ORDER BY unfounded DESC LIMIT 20`,
  ).bind(c.now - 365 * DAY).all();
  return json({ items: rows.results });
}

export async function timeseries(c) {
  await requireModerator(c);
  const days = 30;
  const today = utcDay(c.now);
  const first = today - days + 1;
  const since = first * DAY;
  const db = c.env.DB;
  const perDay = async (sql, ...binds) => Object.fromEntries((await db.prepare(sql).bind(...binds).all()).results.map((row) => [row.day, row.n]));
  const [uploads, downloads, people, reports] = await Promise.all([
    perDay("SELECT created_at / 86400000 AS day, COUNT(*) AS n FROM animations WHERE created_at >= ? AND status <> 'draft' GROUP BY day", since),
    perDay('SELECT day, SUM(downloads) AS n FROM animation_daily WHERE day >= ? GROUP BY day', first),
    perDay('SELECT created_at / 86400000 AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day', since),
    perDay('SELECT created_at / 86400000 AS day, COUNT(*) AS n FROM reports WHERE created_at >= ? GROUP BY day', since),
  ]);
  const list = Array.from({ length: days }, (_, i) => first + i);
  const series = (map) => list.map((day) => map[day] || 0);
  return json({ days: list.map((day) => day * DAY), uploads: series(uploads), downloads: series(downloads), people: series(people), reports: series(reports) });
}

// ---------------------------------------------------------------- bulk decisions

export async function bulkCases(c) {
  const actor = await requireModerator(c);
  const body = await readJson(c.request, 32 * 1024);
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].slice(0, 50) : [];
  if (!ids.length) throw fail(400, 'invalid_field', 'Choose at least one case');
  const action = String(body.action || '');
  const reason = cleanText(body.reason, { field: 'reason', max: LIMITS.reasonMax, multiline: true });
  const results = [];
  for (const raw of ids) {
    let ok = false;
    let code = null;
    try {
      const row = await c.env.DB.prepare('SELECT * FROM cases WHERE id = ?').bind(requireId(raw, 'case')).first();
      if (!row) throw fail(404, 'not_found', 'Unknown case');
      await performCaseAction(c, row, actor, 'panel', action, reason);
      c.waitUntil(notifyCase(c.env, row.id));
      ok = true;
    } catch (error) {
      code = error.code || 'error';
    }
    results.push({ id: raw, ok, code });
  }
  return json({ results, done: results.filter((item) => item.ok).length });
}

// ---------------------------------------------------------------- announcement, re-check, settings

export async function setAnnouncement(c) {
  const actor = await requireModerator(c);
  requirePermission(actor, 'announce');
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const text = body.text === null ? '' : cleanText(body.text, { field: 'text', max: 280, multiline: true });
  const value = text ? JSON.stringify({ text, updated_at: c.now }) : '';
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('announcement', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(value),
    logAction(c, { targetType: 'user', targetId: actor.id, actorId: actor.id, source: 'panel', action: text ? 'announcement_set' : 'announcement_cleared', reason: text }),
  ]);
  return json({ announcement: text ? { text, updated_at: c.now } : null });
}

export async function getAnnouncement(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'announcement'").first();
  try { return row && row.value ? JSON.parse(row.value) : null; } catch { return null; }
}

// Queues a new automatic check for every live animation; the cron starts them a few at a time.
export async function recheckAll(c) {
  const actor = await requireModerator(c);
  requirePermission(actor, 'recheck');
  const db = c.env.DB;
  const rows = await db.prepare(
    `SELECT id FROM animations WHERE status IN ('published', 'review', 'hidden')
     AND id NOT IN (SELECT subject_id FROM pipeline_jobs WHERE kind = 'animation' AND status IN ('queued', 'dispatched', 'running'))
     LIMIT 1000`,
  ).all();
  const statements = rows.results.map((row) => db.prepare(
    "INSERT INTO pipeline_jobs (id, kind, subject_id, status, created_at, updated_at) VALUES (?, 'animation', ?, 'queued', ?, ?)",
  ).bind(newId(), row.id, c.now, c.now));
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
  await logAction(c, { targetType: 'user', targetId: actor.id, actorId: actor.id, source: 'panel', action: 'recheck_all', reason: String(rows.results.length) }).run();
  return json({ queued: rows.results.length });
}

export async function readSettings(c) {
  await requireOwner(c);
  return json(await getSettings(c.env));
}

export async function writeSettings(c) {
  const owner = await requireOwner(c);
  const next = cleanSettings(await readJson(c.request, LIMITS.jsonBodyBytes), await getSettings(c.env));
  await c.env.DB.batch([
    saveSettingsStatement(c.env, next),
    logAction(c, { targetType: 'user', targetId: owner.id, actorId: owner.id, source: 'panel', action: 'settings', reason: JSON.stringify(next).slice(0, 480) }),
  ]);
  return json(next);
}

// ---------------------------------------------------------------- LGPD export

export async function exportPerson(c) {
  const actor = await requireModerator(c);
  requirePermission(actor, 'export');
  const user = await personByHandle(c, c.params.handle);
  const db = c.env.DB;
  const all = async (sql) => (await db.prepare(sql).bind(user.id).all()).results;
  const { id: _id, github_id: githubId, ...profile } = user;
  const data = {
    exported_at: new Date(c.now).toISOString(),
    profile: { ...profile, github_id: githubId },
    animations: await all('SELECT id, title, description, tags, license, credits, status, status_reason, size_bytes, width, height, fps, downloads, created_at, published_at FROM animations WHERE owner_id = ?'),
    images: await all('SELECT id, kind, content_type, size_bytes, status, created_at FROM media WHERE owner_id = ?'),
    ratings: await all('SELECT animation_id, stars, updated_at FROM ratings WHERE user_id = ?'),
    following: await all('SELECT u.handle, f.created_at FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ?'),
    followers: await all('SELECT u.handle, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ?'),
    reports_made: await all('SELECT target_type, target_id, category, note, created_at FROM reports WHERE reporter_id = ?'),
    notifications: await all('SELECT kind, reason, data, created_at, read_at FROM notifications WHERE user_id = ?'),
    punishments: await all('SELECT kind, restrictions, reason, created_at, ends_at, revoked_at FROM sanctions WHERE user_id = ?'),
    team_notes: await all("SELECT body, created_at FROM mod_notes WHERE target_type = 'user' AND target_id = ?"),
  };
  await logAction(c, { targetType: 'user', targetId: user.id, actorId: actor.id, source: 'panel', action: 'export' }).run();
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="bas-community-${user.handle}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
