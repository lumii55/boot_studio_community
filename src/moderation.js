// Moderation: cases, automatic verdicts, the panel queue and moderator actions.
//
// Panel tabs:
//   mass    – reported by several distinct accounts; the item is hidden until someone decides (urgent).
//   reports – one or a few reports, ordered by severity, so a single critical report is on top.
//   review  – automatic checks found something, or the uploader is new.

import { isModerator, requireModerator, requireOwner } from './auth.js';
import { LIMITS, NEW_ACCOUNT_DAYS } from './config.js';
import { notifyCase } from './discord.js';
import { fail, json, readJson } from './lib/http.js';
import { personSearchText } from './lib/search.js';
import { cleanText, decodeCursor, encodeCursor, HANDLE_RE, newId, requireId } from './lib/util.js';
import { animationKey, mediaKey, previewKey, releaseStorageStatement } from './storage.js';
import { notifyStatement, publishedNotifications } from './notifications.js';
import { CASE_ACTION_PERMISSION, cleanPermissions, PERMISSIONS, permissionsOf, requirePermission } from './permissions.js';
import { applySanction } from './sanctions.js';
import { mediaUrl } from './views.js';

export const TAB_SQL = {
  mass: 'mass = 1',
  reports: 'mass = 0 AND report_count > 0',
  review: 'mass = 0 AND report_count = 0',
};

export function caseTab(row) {
  if (row.mass) return 'mass';
  return row.report_count > 0 ? 'reports' : 'review';
}

export const ACTIONS = {
  animation: ['approve', 'hide', 'remove', 'ban'],
  media: ['approve', 'remove', 'ban'],
  user: ['approve', 'clear_profile', 'ban'],
};

export function logAction(c, { caseId = null, targetType, targetId, actorId = null, source = 'system', action, reason = '' }) {
  return c.env.DB.prepare(
    `INSERT INTO mod_actions (id, case_id, target_type, target_id, actor_id, source, action, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId(), caseId, targetType, targetId, actorId, source, action, String(reason).slice(0, LIMITS.reasonMax), c.now);
}

// Opens a case for the target, or returns the open one (adding findings to it).
export async function openCase(c, { targetType, targetId, kind, findings = [] }) {
  const db = c.env.DB;
  await db.prepare(
    `INSERT INTO cases (id, target_type, target_id, kind, status, findings, opened_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', '[]', ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(newId(), targetType, targetId, kind, c.now, c.now)
    .run();
  const row = await db.prepare("SELECT * FROM cases WHERE target_type = ? AND target_id = ? AND status = 'open'")
    .bind(targetType, targetId)
    .first();
  if (findings.length) {
    const merged = JSON.parse(row.findings).concat(findings).slice(-50);
    await db.prepare('UPDATE cases SET findings = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(merged), c.now, row.id).run();
    row.findings = JSON.stringify(merged);
  }
  return row;
}

function trustedUploader(user) {
  return isModerator(user) || user.trust >= 1;
}

function firstMessage(findings, fallback) {
  const worst = [...findings].sort((a, b) => b.severity - a.severity)[0];
  return worst && worst.message ? worst.message : fallback;
}

// `row` is the animation as it was before publishing (its published_at tells whether this is the first time).
function publishStatements(c, row) {
  return [
    c.env.DB.prepare(
      `UPDATE animations SET status = 'published', status_reason = '', published_at = COALESCE(published_at, ?), updated_at = ?
       WHERE id = ?`,
    ).bind(c.now, c.now, row.id),
    ...publishedNotifications(c, row),
  ];
}

async function deleteAnimationFiles(c, row) {
  await c.env.FILES.delete([animationKey(row.id), previewKey(row.id)]);
}

// --- automatic verdicts (called by pipeline.js) ---------------------------------------------------

export async function applyAnimationVerdict(c, id, result) {
  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM animations WHERE id = ?').bind(id).first();
  if (!row) return;
  const meta = result.metadata || {};
  const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const credits = JSON.parse(row.credits);
  const detected = result.detected || {};
  if (typeof detected.manufacturer === 'string' && detected.manufacturer) {
    credits.detected_manufacturer = detected.manufacturer.slice(0, 40);
  }
  await db.prepare(
    `UPDATE animations SET width = ?, height = ?, fps = ?, frame_count = ?, parts = ?, has_audio = ?, credits = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(int(meta.width), int(meta.height), int(meta.fps), int(meta.frame_count), int(meta.parts), meta.has_audio ? 1 : 0,
      JSON.stringify(credits), c.now, id)
    .run();

  if (row.status !== 'scanning') {
    // A re-scan (after a report or an edit). Clean: only note it on an open case, if there is one.
    // Otherwise add the findings to a case, and hide the item if the checks reject it.
    if (result.verdict === 'clean') {
      const existing = await db.prepare("SELECT id FROM cases WHERE target_type = 'animation' AND target_id = ? AND status = 'open'")
        .bind(id).first();
      if (existing) {
        await openCase(c, { targetType: 'animation', targetId: id, kind: 'automod',
          findings: [{ code: 'rescan_clean', severity: 0, message: 'Automatic re-check found nothing.' }] });
        c.waitUntil(notifyCase(c.env, existing.id));
      }
      return;
    }
    const open = await openCase(c, { targetType: 'animation', targetId: id, kind: 'automod', findings: result.findings });
    if (result.verdict === 'reject' && row.status === 'published') {
      await db.batch([
        db.prepare("UPDATE animations SET status = 'hidden', status_reason = ?, updated_at = ? WHERE id = ?")
          .bind(firstMessage(result.findings, 'Hidden by automatic checks'), c.now, id),
        db.prepare('UPDATE cases SET auto_hidden = 1, updated_at = ? WHERE id = ?').bind(c.now, open.id),
        logAction(c, { caseId: open.id, targetType: 'animation', targetId: id, action: 'auto_hide', reason: 'rescan rejected' }),
      ]);
    }
    c.waitUntil(notifyCase(c.env, open.id));
    return;
  }

  if (result.verdict === 'reject') {
    await db.batch([
      db.prepare("UPDATE animations SET status = 'rejected', status_reason = ?, has_preview = 0, updated_at = ? WHERE id = ?")
        .bind(firstMessage(result.findings, 'Rejected by automatic checks'), c.now, id),
      releaseStorageStatement(c.env, row.size_bytes),
      logAction(c, { targetType: 'animation', targetId: id, action: 'auto_reject', reason: firstMessage(result.findings, '') }),
      notifyStatement(c, { userId: row.owner_id, kind: 'refused', animationId: id, reason: firstMessage(result.findings, '') }),
    ]);
    await deleteAnimationFiles(c, row);
    return;
  }

  const owner = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.owner_id).first();
  if (result.verdict === 'clean' && owner && trustedUploader(owner)) {
    await db.batch([...publishStatements(c, row), logAction(c, { targetType: 'animation', targetId: id, action: 'auto_publish' })]);
    return;
  }
  const findings = result.verdict === 'clean'
    ? [{ code: 'new_uploader', severity: 0, message: 'Clean, but the uploader is not established yet.' }]
    : result.findings;
  await db.prepare("UPDATE animations SET status = 'review', status_reason = '', updated_at = ? WHERE id = ?").bind(c.now, id).run();
  const opened = await openCase(c, { targetType: 'animation', targetId: id, kind: result.verdict === 'clean' ? 'review' : 'automod', findings });
  c.waitUntil(notifyCase(c.env, opened.id));
}

export async function applyMediaVerdict(c, id, result) {
  const db = c.env.DB;
  const media = await db.prepare('SELECT * FROM media WHERE id = ?').bind(id).first();
  if (!media || media.status !== 'pending') return;
  if (result.verdict === 'clean') return approveMedia(c, media);
  if (result.verdict === 'reject') return rejectMedia(c, media, { action: 'auto_reject', reason: firstMessage(result.findings, '') });
  const opened = await openCase(c, { targetType: 'media', targetId: id, kind: 'automod', findings: result.findings });
  c.waitUntil(notifyCase(c.env, opened.id));
}

export async function applyProfileVerdict(c, userId, result) {
  // Text is never punished automatically: anything suspicious goes to a person.
  if (result.verdict === 'clean') return;
  const opened = await openCase(c, { targetType: 'user', targetId: userId, kind: 'automod', findings: result.findings });
  c.waitUntil(notifyCase(c.env, opened.id));
}

async function approveMedia(c, media) {
  const db = c.env.DB;
  const column = media.kind === 'avatar' ? 'avatar_media_id' : 'banner_media_id';
  const user = await db.prepare(`SELECT ${column} AS current FROM users WHERE id = ?`).bind(media.owner_id).first();
  const statements = [
    db.prepare("UPDATE media SET status = 'approved' WHERE id = ?").bind(media.id),
    db.prepare(`UPDATE users SET ${column} = ?, updated_at = ? WHERE id = ?`).bind(media.id, c.now, media.owner_id),
  ];
  const previous = user && user.current && user.current !== media.id
    ? await db.prepare('SELECT id, size_bytes FROM media WHERE id = ?').bind(user.current).first()
    : null;
  if (previous) {
    statements.push(db.prepare('DELETE FROM media WHERE id = ?').bind(previous.id), releaseStorageStatement(c.env, previous.size_bytes));
  }
  await db.batch(statements);
  if (previous) await c.env.FILES.delete(mediaKey(previous.id));
}

async function rejectMedia(c, media, { caseId = null, actorId = null, source = 'system', action, reason }) {
  const db = c.env.DB;
  const column = media.kind === 'avatar' ? 'avatar_media_id' : 'banner_media_id';
  await db.batch([
    db.prepare('DELETE FROM media WHERE id = ?').bind(media.id),
    db.prepare(`UPDATE users SET ${column} = NULL WHERE id = ? AND ${column} = ?`).bind(media.owner_id, media.id),
    releaseStorageStatement(c.env, media.size_bytes),
    logAction(c, { caseId, targetType: 'media', targetId: media.id, actorId, source, action, reason }),
  ]);
  await c.env.FILES.delete(mediaKey(media.id));
}

// --- moderator actions (panel and Discord) --------------------------------------------------------

export async function performCaseAction(c, caseRow, actor, source, action, reason = '') {
  if (caseRow.status !== 'open') throw fail(409, 'case_closed', 'This case was already decided');
  if (!(ACTIONS[caseRow.target_type] || []).includes(action)) throw fail(400, 'invalid_action', 'Action not available here');
  requirePermission(actor, CASE_ACTION_PERMISSION[action]);
  const db = c.env.DB;
  const target = { caseId: caseRow.id, targetType: caseRow.target_type, targetId: caseRow.target_id, actorId: actor.id, source };
  const closeCase = db.prepare("UPDATE cases SET status = 'closed', resolution = ?, updated_at = ? WHERE id = ?")
    .bind(action, c.now, caseRow.id);
  const log = logAction(c, { ...target, action, reason });

  if (action === 'ban') {
    const ownerId = await ownerOfTarget(c, caseRow);
    if (!ownerId) throw fail(404, 'not_found', 'Target no longer exists');
    if (ownerId === actor.id) throw fail(400, 'invalid_action', 'You cannot ban yourself');
    const victim = await db.prepare('SELECT * FROM users WHERE id = ?').bind(ownerId).first();
    if (victim && victim.role === 'owner') throw fail(403, 'forbidden', 'The owner cannot be banned');
    // A ban from a case is the same permanent ban as from the person's file (recorded as a punishment).
    await applySanction(c, actor, victim, { kind: 'ban', reason: reason || 'Banned from a case', days: null, restrictions: [], hideUploads: false },
      { source, caseId: caseRow.id });
    await closeCase.run();
    return;
  }

  if (caseRow.target_type === 'animation') {
    const row = await db.prepare('SELECT * FROM animations WHERE id = ?').bind(caseRow.target_id).first();
    if (!row) throw fail(404, 'not_found', 'Target no longer exists');
    if (action === 'approve') {
      const owner = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.owner_id).first();
      const statements = [closeCase, log];
      if (['review', 'hidden', 'scanning'].includes(row.status)) statements.unshift(...publishStatements(c, row));
      // Approving an upload earns trust, once the GitHub account is old enough.
      if (owner && owner.trust === 0 && c.now - owner.github_created_at >= NEW_ACCOUNT_DAYS * 86400000) {
        statements.push(db.prepare('UPDATE users SET trust = 1 WHERE id = ?').bind(owner.id));
      }
      await db.batch(statements);
    } else if (action === 'hide') {
      await db.batch([
        db.prepare("UPDATE animations SET status = 'hidden', status_reason = ?, updated_at = ? WHERE id = ?")
          .bind(reason || 'Hidden by a moderator', c.now, row.id),
        closeCase,
        log,
      ]);
    } else if (action === 'remove') {
      // 'rejected' keeps the row, so the same file cannot simply be uploaded again.
      await db.batch([
        db.prepare("UPDATE animations SET status = 'rejected', status_reason = ?, has_preview = 0, updated_at = ? WHERE id = ?")
          .bind(reason || 'Removed by a moderator', c.now, row.id),
        releaseStorageStatement(c.env, row.status === 'rejected' ? 0 : row.size_bytes),
        notifyStatement(c, { userId: row.owner_id, kind: 'refused', animationId: row.id, reason: reason || '' }),
        closeCase,
        log,
      ]);
      await deleteAnimationFiles(c, row);
    }
    return;
  }

  if (caseRow.target_type === 'media') {
    const media = await db.prepare('SELECT * FROM media WHERE id = ?').bind(caseRow.target_id).first();
    if (action === 'approve') {
      if (media && media.status === 'pending') await approveMedia(c, media);
      await db.batch([closeCase, log]);
    } else if (media) {
      await rejectMedia(c, media, { ...target, action, reason });
      await closeCase.run();
    } else {
      await db.batch([closeCase, log]);
    }
    return;
  }

  // user
  if (action === 'clear_profile') {
    const user = await db.prepare('SELECT id, handle FROM users WHERE id = ?').bind(caseRow.target_id).first();
    if (!user) throw fail(404, 'not_found', 'Target no longer exists');
    const media = await db.prepare('SELECT id, size_bytes FROM media WHERE owner_id = ?').bind(user.id).all();
    const freed = media.results.reduce((sum, item) => sum + item.size_bytes, 0);
    await db.batch([
      db.prepare(
        `UPDATE users SET display_name = handle, bio = '', links = '[]', avatar_media_id = NULL, banner_media_id = NULL,
         search_name = ?, updated_at = ? WHERE id = ?`,
      ).bind(personSearchText({ handle: user.handle, display_name: user.handle }), c.now, user.id),
      db.prepare('DELETE FROM media WHERE owner_id = ?').bind(user.id),
      releaseStorageStatement(c.env, freed),
      closeCase,
      log,
    ]);
    if (media.results.length) await c.env.FILES.delete(media.results.map((item) => mediaKey(item.id)));
    return;
  }
  await db.batch([closeCase, log]);
}

async function ownerOfTarget(c, caseRow) {
  const db = c.env.DB;
  if (caseRow.target_type === 'user') return caseRow.target_id;
  const table = caseRow.target_type === 'animation' ? 'animations' : 'media';
  const row = await db.prepare(`SELECT owner_id FROM ${table} WHERE id = ?`).bind(caseRow.target_id).first();
  return row ? row.owner_id : null;
}

// --- views ---------------------------------------------------------------------------------------

export const panelUrl = (env, caseId) => `${new URL(env.SITE_URL).href.split('#')[0]}#community/mod/case/${caseId}`;

export async function targetSummary(c, caseRow) {
  const db = c.env.DB;
  if (caseRow.target_type === 'animation') {
    const row = await db.prepare(
      `SELECT a.id, a.title, a.status, a.has_preview, a.width, a.height, o.handle FROM animations a
       JOIN users o ON o.id = a.owner_id WHERE a.id = ?`,
    ).bind(caseRow.target_id).first();
    if (!row) return { missing: true };
    return {
      title: row.title,
      status: row.status,
      owner: row.handle,
      resolution: `${row.width}x${row.height}`,
      preview_url: row.has_preview ? new URL(`/v1/animations/${row.id}/preview`, c.env.PUBLIC_URL).href : null,
    };
  }
  if (caseRow.target_type === 'media') {
    const row = await db.prepare(
      'SELECT m.id, m.kind, m.status, u.handle FROM media m JOIN users u ON u.id = m.owner_id WHERE m.id = ?',
    ).bind(caseRow.target_id).first();
    if (!row) return { missing: true };
    return { title: `${row.kind} of @${row.handle}`, owner: row.handle, status: row.status, image_url: mediaUrl(c.env, row.id) };
  }
  const row = await db.prepare('SELECT handle, display_name, bio, status FROM users WHERE id = ?').bind(caseRow.target_id).first();
  if (!row) return { missing: true };
  return { title: `@${row.handle}`, owner: row.handle, display_name: row.display_name, bio: row.bio, status: row.status };
}

async function caseView(c, row) {
  return {
    id: row.id,
    tab: caseTab(row),
    kind: row.kind,
    target_type: row.target_type,
    target_id: row.target_id,
    target: await targetSummary(c, row),
    report_count: row.report_count,
    max_severity: row.max_severity,
    auto_hidden: !!row.auto_hidden,
    findings: JSON.parse(row.findings),
    actions: ACTIONS[row.target_type],
    status: row.status,
    resolution: row.resolution,
    opened_at: row.opened_at,
    updated_at: row.updated_at,
    panel_url: panelUrl(c.env, row.id),
  };
}

const QUEUE_ORDER = {
  mass: { order: 'updated_at DESC, id DESC', keys: ['updated_at', 'id'], cmp: '(updated_at, id) < (?, ?)' },
  reports: {
    order: 'max_severity DESC, updated_at DESC, id DESC',
    keys: ['max_severity', 'updated_at', 'id'],
    cmp: '(max_severity, updated_at, id) < (?, ?, ?)',
  },
  review: { order: 'opened_at ASC, id ASC', keys: ['opened_at', 'id'], cmp: '(opened_at, id) > (?, ?)' },
};

export async function queue(c) {
  await requireModerator(c);
  const tab = c.url.searchParams.get('tab') || 'mass';
  if (!TAB_SQL[tab]) throw fail(400, 'invalid_tab', 'Unknown tab');
  const spec = QUEUE_ORDER[tab];
  const cursor = decodeCursor(c.url.searchParams.get('cursor'), spec.keys.length);
  const binds = cursor || [];
  const rows = await c.env.DB.prepare(
    `SELECT * FROM cases WHERE status = 'open' AND ${TAB_SQL[tab]} ${cursor ? `AND ${spec.cmp}` : ''}
     ORDER BY ${spec.order} LIMIT ?`,
  )
    .bind(...binds, LIMITS.pageSize + 1)
    .all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const items = [];
  for (const row of page) items.push(await caseView(c, row));
  const last = page[page.length - 1];
  return json({
    tab,
    items,
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor(spec.keys.map((key) => last[key])) : null,
  });
}

export async function summary(c) {
  await requireModerator(c);
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN ${TAB_SQL.mass} THEN 1 ELSE 0 END) AS mass,
       SUM(CASE WHEN ${TAB_SQL.reports} THEN 1 ELSE 0 END) AS reports,
       SUM(CASE WHEN ${TAB_SQL.reports} AND max_severity >= 3 THEN 1 ELSE 0 END) AS critical_reports,
       SUM(CASE WHEN ${TAB_SQL.review} THEN 1 ELSE 0 END) AS review
     FROM cases WHERE status = 'open'`,
  ).first();
  return json({
    mass: row.mass || 0,
    reports: row.reports || 0,
    critical_reports: row.critical_reports || 0,
    review: row.review || 0,
  });
}

export async function caseDetail(c) {
  await requireModerator(c);
  const row = await c.env.DB.prepare('SELECT * FROM cases WHERE id = ?').bind(requireId(c.params.id, 'case')).first();
  if (!row) throw fail(404, 'not_found', 'Unknown case');
  const reports = await c.env.DB.prepare(
    `SELECT r.category, r.severity, r.note, r.created_at, u.handle AS reporter FROM reports r
     LEFT JOIN users u ON u.id = r.reporter_id WHERE r.case_id = ? ORDER BY r.severity DESC, r.created_at`,
  ).bind(row.id).all();
  const history = await c.env.DB.prepare(
    `SELECT m.action, m.source, m.reason, m.created_at, u.handle AS actor FROM mod_actions m
     LEFT JOIN users u ON u.id = m.actor_id WHERE m.target_type = ? AND m.target_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 50`,
  ).bind(row.target_type, row.target_id).all();
  return json({ ...(await caseView(c, row)), reports: reports.results, history: history.results });
}

export async function caseAction(c) {
  const actor = await requireModerator(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const row = await c.env.DB.prepare('SELECT * FROM cases WHERE id = ?').bind(requireId(c.params.id, 'case')).first();
  if (!row) throw fail(404, 'not_found', 'Unknown case');
  const reason = cleanText(body.reason, { field: 'reason', max: LIMITS.reasonMax, multiline: true });
  await performCaseAction(c, row, actor, 'panel', String(body.action || ''), reason);
  c.waitUntil(notifyCase(c.env, row.id));
  return json({ ok: true });
}

export async function audit(c) {
  await requireModerator(c);
  const params = c.url.searchParams;
  const where = [];
  const binds = [];
  // Filters: who did it (actor handle), what (action prefix) and about whom (person handle: their profile or uploads).
  const actor = (params.get('actor') || '').trim().toLowerCase().replace(/^@/, '');
  if (actor) {
    where.push('u.handle = ?');
    binds.push(actor);
  }
  const action = (params.get('action') || '').trim();
  if (/^[a-z_]{1,40}$/.test(action)) {
    where.push('m.action LIKE ?');
    binds.push(`${action}%`);
  }
  const person = (params.get('person') || '').trim().toLowerCase().replace(/^@/, '');
  if (person) {
    where.push(`((m.target_type = 'user' AND m.target_id = (SELECT id FROM users WHERE handle = ?))
      OR (m.target_type = 'animation' AND m.target_id IN (SELECT a.id FROM animations a JOIN users p ON p.id = a.owner_id WHERE p.handle = ?)))`);
    binds.push(person, person);
  }
  const cursor = decodeCursor(params.get('cursor'), 2);
  if (cursor) {
    where.push('(m.created_at, m.rowid) < (?, ?)');
    binds.push(...cursor);
  }
  const rows = await c.env.DB.prepare(
    `SELECT m.rowid AS seq, m.id, m.case_id, m.target_type, m.target_id, m.source, m.action, m.reason, m.created_at, u.handle AS actor
     FROM mod_actions m LEFT JOIN users u ON u.id = m.actor_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
  )
    .bind(...binds, LIMITS.pageSize + 1)
    .all();
  const page = rows.results.slice(0, LIMITS.pageSize);
  const last = page[page.length - 1];
  return json({
    items: page.map(({ seq, ...item }) => item),
    next_cursor: rows.results.length > LIMITS.pageSize ? encodeCursor([last.created_at, last.seq]) : null,
  });
}

export async function team(c) {
  await requireModerator(c);
  const rows = await c.env.DB.prepare(
    "SELECT handle, display_name, role, permissions, discord_id IS NOT NULL AS discord_linked FROM users WHERE role <> 'user' AND status = 'active' ORDER BY role DESC, handle",
  ).all();
  return json({
    permissions: PERMISSIONS,
    items: rows.results.map((row) => ({ ...row, permissions: permissionsOf(row), discord_linked: !!row.discord_linked })),
  });
}

// Owner-only team management: promote moderators and link their Discord accounts (for the bot buttons).
export async function setRole(c) {
  const owner = await requireOwner(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const handle = String(c.params.handle || '').toLowerCase();
  if (!HANDLE_RE.test(handle)) throw fail(404, 'not_found', 'Unknown user');
  if (!['user', 'moderator'].includes(body.role)) throw fail(400, 'invalid_role', 'Role must be user or moderator');
  // New moderators start with no permissions unless some are given; leaving the team clears them.
  const permissions = body.role === 'moderator' && body.permissions !== undefined ? cleanPermissions(body.permissions) : [];
  const row = await c.env.DB.prepare(
    `UPDATE users SET role = ?, permissions = CASE WHEN ? = 'moderator' AND role = 'moderator' AND ? = 0 THEN permissions ELSE ? END,
       updated_at = ? WHERE handle = ? AND role <> 'owner' RETURNING id`,
  )
    .bind(body.role, body.role, body.permissions !== undefined ? 1 : 0, JSON.stringify(permissions), c.now, handle)
    .first();
  if (!row) throw fail(404, 'not_found', 'Unknown user');
  await logAction(c, { targetType: 'user', targetId: row.id, actorId: owner.id, source: 'panel', action: `role_${body.role}` }).run();
  return json({ ok: true });
}

export async function setPermissions(c) {
  const owner = await requireOwner(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const handle = String(c.params.handle || '').toLowerCase();
  const permissions = cleanPermissions(body.permissions);
  const row = await c.env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE handle = ? AND role = 'moderator' RETURNING id")
    .bind(JSON.stringify(permissions), c.now, handle).first();
  if (!row) throw fail(404, 'not_found', 'Not a moderator');
  await logAction(c, { targetType: 'user', targetId: row.id, actorId: owner.id, source: 'panel', action: 'permissions', reason: permissions.join(', ') }).run();
  return json({ ok: true, permissions });
}

export async function setDiscord(c) {
  const owner = await requireOwner(c);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const handle = String(c.params.handle || '').toLowerCase();
  const discordId = body.discord_id === null ? null : String(body.discord_id || '');
  if (discordId !== null && !/^\d{17,20}$/.test(discordId)) throw fail(400, 'invalid_discord_id', 'Invalid Discord user ID');
  let row;
  try {
    row = await c.env.DB.prepare('UPDATE users SET discord_id = ?, updated_at = ? WHERE handle = ? RETURNING id')
      .bind(discordId, c.now, handle)
      .first();
  } catch {
    throw fail(409, 'discord_in_use', 'That Discord account is linked to someone else');
  }
  if (!row) throw fail(404, 'not_found', 'Unknown user');
  await logAction(c, { targetType: 'user', targetId: row.id, actorId: owner.id, source: 'panel', action: 'discord_link' }).run();
  return json({ ok: true });
}
