// Community settings the owner can change in the panel. Stored as one JSON row; defaults fill the gaps.

import { LIMITS, MASS_REPORT_THRESHOLD, RATE } from './config.js';
import { fail } from './lib/http.js';

export const DEFAULT_SETTINGS = Object.freeze({
  max_animation_mb: LIMITS.animationBytes / (1024 * 1024),
  uploads_per_hour: RATE.uploadHour[0],
  uploads_per_day: RATE.uploadDay[0],
  mass_report_threshold: MASS_REPORT_THRESHOLD,
  detector: 'normal', // relaxed | normal | strict
  discord_events: { mass: true, reports: true, review: true, automod: true },
});

const RANGES = {
  max_animation_mb: [1, 50],
  uploads_per_hour: [1, 50],
  uploads_per_day: [1, 200],
  mass_report_threshold: [2, 20],
};

export async function getSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'community_config'").first();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    discord_events: { ...DEFAULT_SETTINGS.discord_events, ...(saved.discord_events || {}) },
  };
}

export function cleanSettings(input, current) {
  const next = { ...current, discord_events: { ...current.discord_events } };
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw fail(400, 'invalid_setting', `${key} must be ${min}–${max}`, { details: { field: key, min, max } });
    }
    next[key] = value;
  }
  if (input.detector !== undefined) {
    if (!['relaxed', 'normal', 'strict'].includes(input.detector)) throw fail(400, 'invalid_setting', 'Unknown detector level');
    next.detector = input.detector;
  }
  if (input.discord_events !== undefined) {
    for (const key of Object.keys(DEFAULT_SETTINGS.discord_events)) {
      if (input.discord_events[key] !== undefined) next.discord_events[key] = !!input.discord_events[key];
    }
  }
  return next;
}

export function saveSettingsStatement(env, settings) {
  return env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('community_config', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).bind(JSON.stringify(settings));
}
