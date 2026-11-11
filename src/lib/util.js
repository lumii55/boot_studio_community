// Small shared helpers: ids, hashing, encoding, validation.

import { fail } from './http.js';

export function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export const newId = () => randomToken(12);

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return hex(await crypto.subtle.digest('SHA-256', data));
}

export const ID_RE = /^[A-Za-z0-9_-]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

export function requireId(value, what = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw fail(404, 'not_found', `Unknown ${what}`);
  return value;
}

// Text fields: strip control characters (keep newlines where allowed), trim, enforce length.
export function cleanText(value, { field, max, min = 0, multiline = false }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw fail(400, 'invalid_field', `${field} must be text`, { details: { field } });
  const pattern = multiline ? /[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g : /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g;
  let text = value.replace(/\r\n?/g, '\n').replace(pattern, '').trim();
  if (multiline) text = text.replace(/\n{3,}/g, '\n\n');
  const length = [...text].length;
  if (length < min || length > max) {
    throw fail(400, 'invalid_length', `${field} must be ${min}-${max} characters`, { details: { field, min, max } });
  }
  return text;
}

export function cleanTags(value, { max, tagMax }) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw fail(400, 'invalid_field', 'tags must be a list', { details: { field: 'tags' } });
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, tagMax);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > max) throw fail(400, 'too_many_tags', `At most ${max} tags`, { details: { field: 'tags', max } });
  return tags;
}

export function cleanLinks(value, { max, linkMax }) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw fail(400, 'invalid_field', `At most ${max} links`, { details: { field: 'links', max } });
  }
  return value.map((raw) => {
    let url;
    try {
      url = new URL(String(raw));
    } catch {
      throw fail(400, 'invalid_link', 'Links must be https URLs', { details: { field: 'links' } });
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > linkMax) {
      throw fail(400, 'invalid_link', 'Links must be https URLs', { details: { field: 'links' } });
    }
    return url.href;
  });
}

export const utcDay = (ms) => Math.floor(ms / 86400000);

export function encodeCursor(values) {
  return b64url(new TextEncoder().encode(JSON.stringify(values)));
}

export function decodeCursor(text, length) {
  if (!text) return null;
  try {
    const values = JSON.parse(new TextDecoder().decode(b64urlDecode(text)));
    if (Array.isArray(values) && values.length === length) return values;
  } catch {
    // fall through
  }
  throw fail(400, 'invalid_cursor', 'Invalid cursor');
}
