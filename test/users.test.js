import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sniffImage } from '../src/lib/images.js';
import { cleanText } from '../src/lib/util.js';
import {
  CLEAN, createHarness, finishJob, jpegBytes, lastJob, oidcSigner, OWNER_GITHUB_ID, pngBytes, uploadAnimation, webpBytes,
} from './helpers.js';

test('image sniffing reads real headers and refuses everything else', () => {
  assert.deepEqual(sniffImage(pngBytes(512, 256)), { type: 'image/png', ext: 'png', width: 512, height: 256 });
  assert.deepEqual(sniffImage(jpegBytes(640, 480)), { type: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
  assert.deepEqual(sniffImage(webpBytes(1500, 500)), { type: 'image/webp', ext: 'webp', width: 1500, height: 500 });
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a......')), null);
});

test('text cleaning strips control and bidi-override characters', () => {
  assert.equal(cleanText(' Hi‮evil\u0007 ', { field: 'x', max: 20 }), 'Hievil');
  assert.equal(cleanText('a\r\n\r\n\r\n\r\nb', { field: 'x', max: 20, multiline: true }), 'a\n\nb');
  assert.throws(() => cleanText('x'.repeat(21), { field: 'x', max: 20 }), /1?-?20|0-20/);
});

test('profile edits: limits, https links only, text is re-checked', async () => {
  const h = createHarness();
  const { token, user } = await h.signIn('maker');
  const bad = await h.request('PATCH', '/v1/me', { token, json: { links: ['javascript:alert(1)'] } });
  assert.equal(bad.data.error.code, 'invalid_link');
  assert.equal((await h.request('PATCH', '/v1/me', { token, json: { bio: 'x'.repeat(301) } })).status, 400);
  const ok = await h.request('PATCH', '/v1/me', { token, json: { display_name: 'Maker ✨', bio: 'I make boots', links: ['https://example.com/me'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.display_name, 'Maker ✨');
  assert.deepEqual(ok.data.links, ['https://example.com/me']);
  assert.equal(lastJob(h, 'profile', user.id).status, 'dispatched');
  const profile = await h.request('GET', '/v1/users/maker');
  assert.equal(profile.data.bio, 'I make boots');
  assert.equal(profile.data.github_url, 'https://github.com/maker');
});

test('flagged profile text goes to a person, never punished automatically', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const { token, user } = await h.signIn('maker');
  await h.request('PATCH', '/v1/me', { token, json: { bio: 'something' } });
  await finishJob(h, sign, lastJob(h, 'profile', user.id).id, { verdict: 'reject', findings: [{ code: 'hate', severity: 2, message: 'Possible hate speech' }] });
  assert.equal(h.db.row('SELECT bio, status FROM users WHERE id = ?', user.id).bio, 'something');
  assert.equal(h.db.row("SELECT kind FROM cases WHERE target_type = 'user' AND target_id = ?", user.id).kind, 'automod');
});

test('avatars: checked bytes, private until approved, the old one is replaced', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const { token, user } = await h.signIn('maker');
  const stranger = await h.signIn('stranger');
  const svg = await h.request('PUT', '/v1/me/avatar', { token, raw: new TextEncoder().encode('<svg onload=alert(1)>') });
  assert.equal(svg.data.error.code, 'invalid_image');
  const huge = await h.request('PUT', '/v1/me/avatar', { token, raw: pngBytes(4000, 4000) });
  assert.equal(huge.data.error.code, 'invalid_image');
  const big = await h.request('PUT', '/v1/me/avatar', { token, raw: new Uint8Array(600 * 1024) });
  assert.equal(big.status, 413);

  const first = await h.request('PUT', '/v1/me/avatar', { token, raw: pngBytes(256, 256) });
  assert.equal(first.status, 202);
  const mediaPath = `/v1/media/${first.data.id}`;
  assert.equal((await h.request('GET', mediaPath, { token: stranger.token })).status, 404);
  const own = await h.request('GET', mediaPath, { token });
  assert.equal(own.headers.get('Content-Type'), 'image/png');
  assert.equal(own.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await h.request('GET', '/v1/me', { token })).data.pending_avatar_url, `https://api.test${mediaPath}`);

  await finishJob(h, sign, lastJob(h, 'media', first.data.id).id, CLEAN);
  const pub = await h.request('GET', mediaPath);
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get('Cache-Control'), /immutable/);
  assert.equal(pub.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.equal((await h.request('GET', '/v1/users/maker')).data.avatar_url, `https://api.test${mediaPath}`);

  const second = await h.request('PUT', '/v1/me/avatar', { token, raw: webpBytes(300, 300) });
  await finishJob(h, sign, lastJob(h, 'media', second.data.id).id, CLEAN);
  assert.ok(!h.files.has(`media/${first.data.id}`));
  assert.equal(h.db.row('SELECT avatar_media_id FROM users WHERE id = ?', user.id).avatar_media_id, second.data.id);
  const used = Number(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value);
  assert.equal(used, webpBytes(300, 300).byteLength);

  const rejected = await h.request('PUT', '/v1/me/banner', { token, raw: pngBytes(1500, 500) });
  await finishJob(h, sign, lastJob(h, 'media', rejected.data.id).id, { verdict: 'reject', findings: [] });
  assert.ok(!h.files.has(`media/${rejected.data.id}`));
  assert.equal(h.db.row('SELECT banner_media_id FROM users WHERE id = ?', user.id).banner_media_id, null);
});

test('follow / unfollow keep counts exact; you cannot follow yourself', async () => {
  const h = createHarness();
  const a = await h.signIn('alice');
  const b = await h.signIn('bob');
  assert.equal((await h.request('PUT', '/v1/users/alice/follow', { token: a.token })).status, 400);
  assert.deepEqual((await h.request('PUT', '/v1/users/alice/follow', { token: b.token })).data, { following: true, followers: 1 });
  assert.deepEqual((await h.request('PUT', '/v1/users/alice/follow', { token: b.token })).data, { following: true, followers: 1 });
  const profile = await h.request('GET', '/v1/users/alice', { token: b.token });
  assert.equal(profile.data.followed_by_me, true);
  assert.equal((await h.request('GET', '/v1/users/bob')).data.following, 1);
  assert.deepEqual((await h.request('GET', '/v1/users/alice/followers')).data.items.map((item) => item.handle), ['bob']);
  assert.deepEqual((await h.request('DELETE', '/v1/users/alice/follow', { token: b.token })).data, { following: false, followers: 0 });
});

test('deleting an account removes files, ratings, follows and open cases', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const leaver = await h.signIn('leaver');
  const ownerAnim = await uploadAnimation(h, owner.token, { title: 'Owner boot' });
  await finishJob(h, sign, lastJob(h, 'animation', ownerAnim).id, CLEAN);
  const mine = await uploadAnimation(h, leaver.token, { title: 'Leaver boot' });
  await finishJob(h, sign, lastJob(h, 'animation', mine).id, CLEAN); // → review case
  await h.request('PUT', `/v1/animations/${ownerAnim}/rating`, { token: leaver.token, json: { stars: 1 } });
  await h.request('PUT', '/v1/users/lumii55/follow', { token: leaver.token });

  assert.equal((await h.request('DELETE', '/v1/me', { token: leaver.token, json: { confirm: 'nope' } })).data.error.code, 'confirm_required');
  assert.equal((await h.request('DELETE', '/v1/me', { token: leaver.token, json: { confirm: 'leaver' } })).status, 200);
  assert.equal(h.db.row('SELECT id FROM users WHERE handle = ?', 'leaver'), null);
  assert.ok(!h.files.has(`animations/${mine}.zip`));
  assert.deepEqual(h.db.row('SELECT rating_count, downloads FROM animations WHERE id = ?', ownerAnim), { rating_count: 0, downloads: 0 });
  assert.equal(h.db.row('SELECT followers_count FROM users WHERE handle = ?', 'lumii55').followers_count, 0);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM cases WHERE status = 'open'").n, 0);
  const ownerSize = h.db.row('SELECT size_bytes FROM animations WHERE id = ?', ownerAnim).size_bytes;
  assert.equal(Number(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value), ownerSize);
  assert.equal((await h.request('DELETE', '/v1/me', { token: owner.token, json: { confirm: 'lumii55' } })).status, 403);
});
