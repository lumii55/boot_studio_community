// R2 object keys and the global storage guard (pause uploads before the free tier is exceeded).

import { DEFAULT_STORAGE_LIMIT_BYTES } from './config.js';
import { fail } from './lib/http.js';

export const animationKey = (id) => `animations/${id}.zip`;
export const previewKey = (id) => `previews/${id}.webp`;
export const mediaKey = (id) => `media/${id}`;

export function storageLimit(env) {
  const configured = Number(env.STORAGE_LIMIT_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STORAGE_LIMIT_BYTES;
}

export async function storageStatus(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('storage_used_bytes', 'uploads_paused')").all();
  const map = Object.fromEntries(rows.results.map((row) => [row.key, row.value]));
  const used = Number(map.storage_used_bytes || 0);
  const limit = storageLimit(env);
  return { used, limit, paused: map.uploads_paused === '1' || used >= limit };
}

// Reserves space atomically; refuses when the reservation would cross the limit.
export async function reserveStorage(env, bytes) {
  const limit = storageLimit(env);
  const row = await env.DB.prepare(
    `UPDATE settings SET value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)
     WHERE key = 'storage_used_bytes' AND CAST(value AS INTEGER) + CAST(? AS INTEGER) <= ?
       AND (SELECT value FROM settings WHERE key = 'uploads_paused') <> '1'
     RETURNING value`,
  )
    .bind(bytes, bytes, limit)
    .first();
  if (!row) throw fail(507, 'uploads_paused', 'Uploads are paused for now, try again later');
}

export function releaseStorageStatement(env, bytes) {
  return env.DB.prepare(
    "UPDATE settings SET value = CAST(MAX(0, CAST(value AS INTEGER) - CAST(? AS INTEGER)) AS TEXT) WHERE key = 'storage_used_bytes'",
  ).bind(bytes);
}

export async function releaseStorage(env, bytes) {
  if (bytes > 0) await releaseStorageStatement(env, bytes).run();
}
