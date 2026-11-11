import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, uploadAnimation } from './helpers.js';

async function world() {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const maker = await h.signIn('maker');
  const fan = await h.signIn('fan');
  const inbox = async (who) => (await h.request('GET', '/v1/me/notifications', { token: who.token })).data.items;
  const unread = async (who) => (await h.request('GET', '/v1/me/notifications/unread', { token: who.token })).data.unread;
  return { h, sign, owner, maker, fan, inbox, unread };
}

test('a follow notifies once per person, even after unfollow + follow', async () => {
  const { h, maker, fan, inbox, unread } = await world();
  await h.request('PUT', '/v1/users/maker/follow', { token: fan.token });
  await h.request('PUT', '/v1/users/maker/follow', { token: fan.token }); // already following: nothing new
  h.advance(1000);
  await h.request('DELETE', '/v1/users/maker/follow', { token: fan.token });
  await h.request('PUT', '/v1/users/maker/follow', { token: fan.token });
  const items = await inbox(maker);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'follow');
  assert.equal(items[0].actor.handle, 'fan');
  assert.equal(await unread(maker), 1);
  await h.request('POST', '/v1/me/notifications/read', { token: maker.token });
  assert.equal(await unread(maker), 0);
  assert.equal((await inbox(maker))[0].read, true);
});

test('approval notifies the uploader; a published remix notifies the original author', async () => {
  const { h, sign, owner, maker, fan, inbox } = await world();
  const original = await uploadAnimation(h, owner.token, { title: 'Original' });
  await finishJob(h, sign, lastJob(h, 'animation', original).id, CLEAN); // owner: auto-published
  assert.deepEqual((await inbox(owner)).map((item) => item.kind), ['published']);

  const remix = await uploadAnimation(h, maker.token, { title: 'Remix', extra: { remix_of: original } });
  await finishJob(h, sign, lastJob(h, 'animation', remix).id, CLEAN); // new uploader → review, no notice yet
  assert.deepEqual(await inbox(maker), []);
  const opened = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", remix);
  await h.request('POST', `/v1/mod/cases/${opened.id}/action`, { token: owner.token, json: { action: 'approve' } });
  const makerInbox = await inbox(maker);
  assert.equal(makerInbox[0].kind, 'published');
  assert.equal(makerInbox[0].animation.title, 'Remix');
  const ownerInbox = await inbox(owner);
  assert.equal(ownerInbox[0].kind, 'remix');
  assert.equal(ownerInbox[0].actor.handle, 'maker');
  assert.equal(ownerInbox[0].animation.id, remix);
  assert.deepEqual(await inbox(fan), []);
});

test('refusals notify with the reason; restoring after reports does not re-announce', async () => {
  const { h, sign, owner, maker, inbox } = await world();
  const bad = await uploadAnimation(h, maker.token, { title: 'Bad zip' });
  await finishJob(h, sign, lastJob(h, 'animation', bad).id, { verdict: 'reject', findings: [{ code: 'zip_unsafe_path', severity: 3, message: 'Unsafe path in ZIP' }] });
  let items = await inbox(maker);
  assert.equal(items[0].kind, 'refused');
  assert.equal(items[0].reason, 'Unsafe path in ZIP');

  h.db.sqlite.prepare('UPDATE users SET trust = 1 WHERE handle = ?').run('maker');
  const good = await uploadAnimation(h, maker.token, { title: 'Good' });
  await finishJob(h, sign, lastJob(h, 'animation', good).id, CLEAN);
  const reporters = [];
  for (let i = 0; i < 3; i++) reporters.push(await h.signIn(`r${i}`));
  for (const r of reporters) await h.request('POST', '/v1/reports', { token: r.token, json: { target_type: 'animation', target_id: good, category: 'spam', turnstile_token: 'turnstile-ok' } });
  const mass = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", good);
  await h.request('POST', `/v1/mod/cases/${mass.id}/action`, { token: owner.token, json: { action: 'approve' } });
  items = await inbox(maker);
  assert.equal(items.filter((item) => item.kind === 'published').length, 1, JSON.stringify(items.map((item) => item.kind)));

  await h.request('POST', '/v1/reports', { token: reporters[0].token, json: { target_type: 'animation', target_id: good, category: 'uncredited', turnstile_token: 'turnstile-ok' } }).catch(() => {});
  const again = await h.request('POST', '/v1/reports', { token: (await h.signIn('r9')).token, json: { target_type: 'animation', target_id: good, category: 'uncredited', turnstile_token: 'turnstile-ok' } });
  assert.equal(again.status, 201);
  const single = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", good);
  await h.request('POST', `/v1/mod/cases/${single.id}/action`, { token: owner.token, json: { action: 'remove', reason: 'Not your art' } });
  items = await inbox(maker);
  assert.equal(items[0].kind, 'refused');
  assert.equal(items[0].reason, 'Not your art');
});

test('notifications need sign-in, are private, and expire after 60 days', async () => {
  const { h, fan, inbox } = await world();
  assert.equal((await h.request('GET', '/v1/me/notifications')).status, 401);
  await h.request('PUT', '/v1/users/maker/follow', { token: fan.token });
  assert.equal((await inbox(fan)).length, 0);
  h.advance(61 * 86400000);
  await h.scheduled();
  assert.equal(h.db.row('SELECT COUNT(*) AS n FROM notifications').n, 0);
});
