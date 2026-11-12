// Search text: lower case, accents and other marks removed, full-width forms made plain, so "animacao" finds
// "Animação" and "yonkagor" finds "YonKaGor". Stored next to the animation (title, description, tags) and the
// person (handle, display name); queries are folded the same way and matched as a substring.

const EXTRA = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

export function foldText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (ch) => EXTRA[ch])
    .replace(/\s+/g, ' ')
    .trim();
}

export function animationSearchText({ title, description, tags }) {
  const list = Array.isArray(tags) ? tags : JSON.parse(tags || '[]');
  return foldText([title, description, list.join(' ')].join(' '));
}

export function personSearchText({ handle, display_name: displayName }) {
  return foldText(`${handle} ${displayName || ''}`);
}

// LIKE pattern for a folded query (with \ as the escape character).
export function containsPattern(text) {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// Cron: fills the search text of rows created before it existed or whose name changed by sign-in.
export async function fillSearchText(c, limit = 300) {
  const db = c.env.DB;
  const animations = await db.prepare('SELECT id, title, description, tags FROM animations WHERE search_text IS NULL LIMIT ?').bind(limit).all();
  const users = await db.prepare('SELECT id, handle, display_name FROM users WHERE search_name IS NULL LIMIT ?').bind(limit).all();
  const statements = [
    ...animations.results.map((row) => db.prepare('UPDATE animations SET search_text = ? WHERE id = ?').bind(animationSearchText(row), row.id)),
    ...users.results.map((row) => db.prepare('UPDATE users SET search_name = ? WHERE id = ?').bind(personSearchText(row), row.id)),
  ];
  if (statements.length) await db.batch(statements);
  return statements.length;
}
