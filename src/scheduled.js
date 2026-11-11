// Cron (every 15 minutes): housekeeping, trending scores and stuck automatic checks.

import { DRAFT_TTL_MS } from './config.js';
import { utcDay } from './lib/util.js';
import { retryStaleJobs } from './pipeline.js';

const TRENDING_DAYS = 7;

export async function runScheduled(c) {
  const db = c.env.DB;
  const today = utcDay(c.now);
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(c.now),
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(c.now),
    db.prepare('DELETE FROM auth_grants WHERE expires_at < ?').bind(c.now),
    db.prepare('DELETE FROM rate_windows WHERE window_start < ?').bind(c.now - 2 * 86400000),
    db.prepare('DELETE FROM download_marks WHERE day < ?').bind(today - 1),
    db.prepare('DELETE FROM animation_daily WHERE day < ?').bind(today - 60),
    db.prepare('DELETE FROM notifications WHERE created_at < ?').bind(c.now - 60 * 86400000),
    // Drafts whose file never arrived (nothing was stored for them).
    db.prepare("DELETE FROM animations WHERE status = 'draft' AND created_at < ?").bind(c.now - DRAFT_TTL_MS),
    // Trending: downloads of the last week, newer days weigh more, plus a small rating component.
    db.prepare(
      `UPDATE animations SET trending = COALESCE((
         SELECT SUM(d.downloads * 1.0 / (1 + ?1 - d.day)) FROM animation_daily d
         WHERE d.animation_id = animations.id AND d.day > ?1 - ?2), 0) + score * 0.5
       WHERE status = 'published'`,
    ).bind(today, TRENDING_DAYS),
  ]);
  await retryStaleJobs(c);
}
