// Reports from signed-in users. Every report reaches the panel:
//   * several distinct reporters → "mass" tab, and a published animation is hidden until decided;
//   * a single critical report (criminal, nudity) → top of the reports tab, highlighted on Discord, and the
//     animation is checked again automatically;
//   * any other report → reports tab, ordered by severity.

import { requireUser } from './auth.js';
import { LIMITS, RATE, REPORT_CATEGORIES } from './config.js';
import { notifyCase } from './discord.js';
import { fail, json, readJson } from './lib/http.js';
import { rateLimit } from './lib/ratelimit.js';
import { requireTurnstile } from './lib/turnstile.js';
import { cleanText, HANDLE_RE, newId, requireId } from './lib/util.js';
import { logAction, openCase } from './moderation.js';
import { queueJob } from './pipeline.js';
import { assertAllowed } from './sanctions.js';
import { getSettings } from './settings.js';

async function resolveTarget(c, type, raw) {
  if (type === 'animation') {
    const row = await c.env.DB.prepare("SELECT id, owner_id, status FROM animations WHERE id = ? AND status = 'published'")
      .bind(requireId(raw, 'animation'))
      .first();
    if (!row) throw fail(404, 'not_found', 'Unknown animation');
    return { id: row.id, ownerId: row.owner_id, published: true };
  }
  if (type === 'user') {
    const handle = String(raw || '').toLowerCase();
    if (!HANDLE_RE.test(handle)) throw fail(404, 'not_found', 'Unknown user');
    const row = await c.env.DB.prepare("SELECT id FROM users WHERE handle = ? AND status = 'active'").bind(handle).first();
    if (!row) throw fail(404, 'not_found', 'Unknown user');
    return { id: row.id, ownerId: row.id, published: false };
  }
  throw fail(400, 'invalid_target', 'Unknown report target');
}

export async function createReport(c) {
  const reporter = await requireUser(c);
  await assertAllowed(c, reporter, 'report');
  await rateLimit(c, 'report', reporter.id, RATE.reportDay);
  const body = await readJson(c.request, LIMITS.jsonBodyBytes);
  const severity = REPORT_CATEGORIES[body.category];
  if (!severity) throw fail(400, 'invalid_category', 'Choose a reason');
  const note = cleanText(body.note, { field: 'note', max: LIMITS.reportNoteMax, multiline: true });
  await requireTurnstile(c, body.turnstile_token);
  const target = await resolveTarget(c, body.target_type, body.target_id);
  if (target.ownerId === reporter.id) throw fail(400, 'own_content', 'You cannot report your own content');

  const db = c.env.DB;
  const opened = await openCase(c, { targetType: body.target_type, targetId: target.id, kind: 'reports' });
  try {
    await db.prepare(
      `INSERT INTO reports (id, case_id, target_type, target_id, reporter_id, category, severity, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId(), opened.id, body.target_type, target.id, reporter.id, body.category, severity, note, c.now).run();
  } catch {
    throw fail(409, 'already_reported', 'You already reported this');
  }
  const counted = await db.prepare(
    `UPDATE cases SET
       report_count = (SELECT COUNT(DISTINCT reporter_id) FROM reports WHERE case_id = ?1),
       max_severity = (SELECT MAX(severity) FROM reports WHERE case_id = ?1),
       updated_at = ?2
     WHERE id = ?1 RETURNING report_count, mass, max_severity`,
  ).bind(opened.id, c.now).first();

  const { mass_report_threshold: threshold } = await getSettings(c.env);
  if (!counted.mass && counted.report_count >= threshold) {
    const statements = [db.prepare('UPDATE cases SET mass = 1, updated_at = ? WHERE id = ?').bind(c.now, opened.id)];
    if (target.published) {
      statements.push(
        db.prepare("UPDATE animations SET status = 'hidden', status_reason = 'Hidden while reports are reviewed', updated_at = ? WHERE id = ? AND status = 'published'")
          .bind(c.now, target.id),
        db.prepare('UPDATE cases SET auto_hidden = 1 WHERE id = ?').bind(opened.id),
        logAction(c, { caseId: opened.id, targetType: 'animation', targetId: target.id, action: 'auto_hide', reason: 'mass reports' }),
      );
    }
    await db.batch(statements);
  } else if (severity >= 3 && body.target_type === 'animation') {
    // One critical report is enough to look again with the automatic checks.
    const recent = await db.prepare(
      "SELECT 1 AS yes FROM pipeline_jobs WHERE kind = 'animation' AND subject_id = ? AND created_at >= ?",
    ).bind(target.id, opened.opened_at).first();
    if (!recent) await queueJob(c, 'animation', target.id);
  }
  c.waitUntil(notifyCase(c.env, opened.id));
  return json({ ok: true }, 201);
}
