// Punishments. Each one has a reason, notifies the person, and (unless permanent) ends by itself.
//   warning  – a recorded notice, nothing is blocked;
//   restrict – blocks chosen actions: upload, report, rate, profile;
//   suspend  – no sign-in for N days; uploads stay visible unless hide_uploads is set;
//   ban      – permanent: signed out, uploads hidden.
// Escalation is only *suggested* (strikes in the last 12 months); nobody is punished automatically.

import { fail } from './lib/http.js';
import { cleanText, newId } from './lib/util.js';
import { logAction } from './moderation.js';
import { notifyStatement } from './notifications.js';
import { requirePermission, SANCTION_PERMISSION } from './permissions.js';

const DAY = 86400000;
export const RESTRICTIONS = ['upload', 'report', 'rate', 'profile'];
const HIDDEN_BY = { ban: 'Account banned', suspend: 'Account suspended' };
export const STRIKE_WINDOW_DAYS = 365;

export function cleanSanction(body) {
  const kind = String(body.kind || '');
  if (!SANCTION_PERMISSION[kind]) throw fail(400, 'invalid_sanction', 'Unknown punishment');
  const reason = cleanText(body.reason, { field: 'reason', min: 1, max: 500, multiline: true });
  let days = body.days === undefined || body.days === null ? null : Number(body.days);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw fail(400, 'invalid_duration', 'Duration must be 1–3650 days');
  if (kind === 'suspend' && days === null) throw fail(400, 'invalid_duration', 'A suspension needs a duration');
  if (kind === 'warning' || kind === 'ban') days = null;
  let restrictions = [];
  if (kind === 'restrict') {
    restrictions = RESTRICTIONS.filter((item) => Array.isArray(body.restrictions) && body.restrictions.includes(item));
    if (!restrictions.length) throw fail(400, 'invalid_sanction', 'Choose at least one restriction');
  }
  return { kind, reason, days, restrictions, hideUploads: kind === 'suspend' && body.hide_uploads === true };
}

function checkTarget(actor, target) {
  if (!target) throw fail(404, 'not_found', 'Unknown user');
  if (target.id === actor.id) throw fail(400, 'invalid_action', 'Not on yourself');
  if (target.role === 'owner') throw fail(403, 'forbidden', 'Not on the owner');
  if (target.role === 'moderator' && actor.role !== 'owner') throw fail(403, 'forbidden', 'Only the owner can act on moderators');
}

export async function applySanction(c, actor, target, input, { source = 'panel', caseId = null } = {}) {
  requirePermission(actor, SANCTION_PERMISSION[input.kind]);
  checkTarget(actor, target);
  const db = c.env.DB;
  const id = newId();
  const endsAt = input.days ? c.now + input.days * DAY : null;
  const statements = [
    db.prepare(
      `INSERT INTO sanctions (id, user_id, kind, restrictions, hide_uploads, reason, actor_id, created_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, target.id, input.kind, JSON.stringify(input.restrictions), input.hideUploads ? 1 : 0, input.reason, actor.id, c.now, endsAt),
    notifyStatement(c, {
      userId: target.id, kind: 'sanction', reason: input.reason,
      data: { sanction: input.kind, restrictions: input.restrictions, ends_at: endsAt },
    }),
    logAction(c, { caseId, targetType: 'user', targetId: target.id, actorId: actor.id, source, action: `sanction_${input.kind}`, reason: input.reason }),
  ];
  if (input.kind === 'ban') {
    statements.push(
      db.prepare("UPDATE users SET status = 'banned', updated_at = ? WHERE id = ?").bind(c.now, target.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
      db.prepare("UPDATE animations SET status = 'hidden', status_reason = ?, updated_at = ? WHERE owner_id = ? AND status IN ('published', 'review', 'scanning')")
        .bind(HIDDEN_BY.ban, c.now, target.id),
    );
  } else if (input.kind === 'suspend') {
    statements.push(
      db.prepare('UPDATE users SET suspended_until = MAX(COALESCE(suspended_until, 0), ?), updated_at = ? WHERE id = ?').bind(endsAt, c.now, target.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
    );
    if (input.hideUploads) {
      statements.push(db.prepare("UPDATE animations SET status = 'hidden', status_reason = ?, updated_at = ? WHERE owner_id = ? AND status = 'published'")
        .bind(HIDDEN_BY.suspend, c.now, target.id));
    }
  }
  await db.batch(statements);
  return id;
}

// Undoes the effects of a ban or suspension that is no longer active.
async function undoEffects(c, sanction) {
  const db = c.env.DB;
  const statements = [];
  if (sanction.kind === 'ban') {
    const otherBan = await db.prepare("SELECT 1 AS yes FROM sanctions WHERE user_id = ? AND kind = 'ban' AND revoked_at IS NULL AND id <> ?")
      .bind(sanction.user_id, sanction.id).first();
    if (!otherBan) {
      statements.push(
        db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").bind(c.now, sanction.user_id),
        db.prepare(`UPDATE animations SET status = CASE WHEN published_at IS NULL THEN 'review' ELSE 'published' END, status_reason = '', updated_at = ?
                    WHERE owner_id = ? AND status = 'hidden' AND status_reason = ?`).bind(c.now, sanction.user_id, HIDDEN_BY.ban),
      );
    }
  } else if (sanction.kind === 'suspend') {
    const other = await db.prepare(`SELECT MAX(ends_at) AS until FROM sanctions WHERE user_id = ? AND kind = 'suspend' AND revoked_at IS NULL
                                    AND id <> ? AND ends_at > ?`).bind(sanction.user_id, sanction.id, c.now).first();
    statements.push(db.prepare('UPDATE users SET suspended_until = ? WHERE id = ?').bind(other && other.until ? other.until : null, sanction.user_id));
    if (!(other && other.until)) {
      statements.push(db.prepare("UPDATE animations SET status = 'published', status_reason = '', updated_at = ? WHERE owner_id = ? AND status = 'hidden' AND status_reason = ?")
        .bind(c.now, sanction.user_id, HIDDEN_BY.suspend));
    }
  }
  return statements;
}

export async function revokeSanction(c, actor, sanctionId, reason = '') {
  const db = c.env.DB;
  const sanction = await db.prepare('SELECT s.*, u.role AS u_role FROM sanctions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').bind(sanctionId).first();
  if (!sanction) throw fail(404, 'not_found', 'Unknown punishment');
  requirePermission(actor, SANCTION_PERMISSION[sanction.kind]);
  if (sanction.u_role === 'moderator' && actor.role !== 'owner') throw fail(403, 'forbidden', 'Only the owner can act on moderators');
  if (sanction.revoked_at) throw fail(409, 'already_revoked', 'Already lifted');
  await db.prepare('UPDATE sanctions SET revoked_at = ?, revoked_by = ? WHERE id = ?').bind(c.now, actor.id, sanction.id).run();
  await db.batch([
    ...(await undoEffects(c, sanction)),
    notifyStatement(c, { userId: sanction.user_id, kind: 'sanction_end', data: { sanction: sanction.kind } }),
    logAction(c, { targetType: 'user', targetId: sanction.user_id, actorId: actor.id, source: 'panel', action: `revoke_${sanction.kind}`, reason }),
  ]);
}

// Cron: suspensions whose time is up are undone once (restrictions simply stop applying).
export async function expireSanctions(c) {
  const due = await c.env.DB.prepare(
    "SELECT * FROM sanctions WHERE kind = 'suspend' AND revoked_at IS NULL AND closed_at IS NULL AND ends_at <= ? LIMIT 50",
  ).bind(c.now).all();
  for (const sanction of due.results) {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE sanctions SET closed_at = ? WHERE id = ?').bind(c.now, sanction.id),
      ...(await undoEffects(c, sanction)),
      notifyStatement(c, { userId: sanction.user_id, kind: 'sanction_end', data: { sanction: 'suspend' } }),
    ]);
  }
}

// Blocks an action while a restriction on it is active.
export async function assertAllowed(c, user, action) {
  const row = await c.env.DB.prepare(
    `SELECT MAX(COALESCE(ends_at, 9007199254740991)) AS until FROM sanctions
     WHERE user_id = ? AND kind = 'restrict' AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ?) AND restrictions LIKE ?`,
  ).bind(user.id, c.now, `%"${action}"%`).first();
  if (row && row.until) {
    const permanent = row.until === 9007199254740991;
    throw fail(403, 'restricted', 'You cannot do this right now', { details: { action, until: permanent ? null : row.until } });
  }
}

export async function strikes(c, userId) {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sanctions WHERE user_id = ? AND revoked_at IS NULL AND created_at >= ?')
    .bind(userId, c.now - STRIKE_WINDOW_DAYS * DAY).first();
  return row.n;
}

// Advice only: what a person with this record might deserve next.
export function suggestion(strikeCount, active) {
  if (active.some((item) => item.kind === 'ban')) return null;
  if (strikeCount >= 5) return 'ban';
  if (strikeCount >= 3) return 'suspend';
  if (strikeCount >= 2) return 'restrict';
  return null;
}
