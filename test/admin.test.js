import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, uploadAnimation } from './helpers.js';

async function world() {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const maker = await h.signIn('maker');
  const mod = await h.signIn('helper');
  await h.request('PUT', '/v1/mod/users/helper/role', { token: owner.token, json: { role: 'moderator' } });
  const published = async (who, title) => {
    const id = await uploadAnimation(h, who.token, { title });
    await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
    return id;
  };
  return { h, sign, owner, maker, mod, published };
}

test('overview: storage, numbers and open cases; only the team sees it', async () => {
  const { h, owner, maker, mod, published } = await world();
  await published(owner, 'Live one');
  await published(maker, 'Waiting one'); // new uploader → review
  const res = await h.request('GET', '/v1/mod/stats', { token: mod.token });
  assert.equal(res.status, 200);
  assert.ok(res.data.storage.used_bytes > 0);
  assert.ok(res.data.storage.limit_bytes > res.data.storage.used_bytes);
  assert.equal(res.data.storage.paused, false);
  assert.deepEqual(res.data.users, { total: 3, new_7d: 3, banned: 0 });
  assert.equal(res.data.animations.published, 1);
  assert.equal(res.data.animations.review, 1);
  assert.equal(res.data.open_cases.review, 1);
  assert.equal((await h.request('GET', '/v1/mod/stats', { token: maker.token })).status, 403);
});

test('the owner can pause and resume uploads; moderators cannot', async () => {
  const { h, owner, maker, mod } = await world();
  assert.equal((await h.request('PUT', '/v1/mod/settings/uploads', { token: mod.token, json: { paused: true } })).status, 403);
  assert.deepEqual((await h.request('PUT', '/v1/mod/settings/uploads', { token: owner.token, json: { paused: true } })).data, { paused: true });
  assert.equal((await h.request('GET', '/v1/config')).data.uploads_open, false);
  await assert.rejects(uploadAnimation(h, maker.token), /uploads_paused/);
  await h.request('PUT', '/v1/mod/settings/uploads', { token: owner.token, json: { paused: false } });
  assert.equal((await h.request('GET', '/v1/config')).data.uploads_open, true);
});

test('people: search, ban/unban (uploads come back), trust; moderators cannot touch moderators or the owner', async () => {
  const { h, owner, maker, mod, published } = await world();
  h.db.sqlite.prepare('UPDATE users SET trust = 1 WHERE handle = ?').run('maker');
  const live = await published(maker, 'Maker live');
  const found = await h.request('GET', '/v1/mod/users?q=mak', { token: mod.token });
  assert.deepEqual(found.data.items.map((item) => [item.handle, item.published]), [['maker', 1]]);
  assert.ok(!('id' in found.data.items[0]));

  assert.equal((await h.request('POST', '/v1/mod/users/maker/action', { token: mod.token, json: { action: 'ban', reason: 'spam' } })).status, 200);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', live).status, 'hidden');
  assert.equal((await h.request('GET', '/v1/me', { token: maker.token })).status, 401);
  assert.deepEqual((await h.request('GET', '/v1/mod/users?filter=banned', { token: mod.token })).data.items.map((item) => item.handle), ['maker']);
  await h.request('POST', '/v1/mod/users/maker/action', { token: mod.token, json: { action: 'unban' } });
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', live).status, 'published');
  await h.request('POST', '/v1/mod/users/maker/action', { token: mod.token, json: { action: 'untrust' } });
  assert.equal(h.db.row("SELECT trust FROM users WHERE handle = 'maker'").trust, 0);

  assert.equal((await h.request('POST', '/v1/mod/users/lumii55/action', { token: mod.token, json: { action: 'ban' } })).status, 403);
  await h.request('PUT', '/v1/mod/users/maker/role', { token: owner.token, json: { role: 'moderator' } });
  assert.equal((await h.request('POST', '/v1/mod/users/maker/action', { token: mod.token, json: { action: 'ban' } })).status, 403);
  assert.equal((await h.request('POST', '/v1/mod/users/maker/action', { token: owner.token, json: { action: 'ban' } })).status, 200);
  const logged = h.db.rows("SELECT action FROM mod_actions WHERE action LIKE 'user_%' ORDER BY rowid").map((row) => row.action);
  assert.deepEqual(logged, ['user_ban', 'user_unban', 'user_untrust', 'user_ban']);
});

test('animations: list by status, hide/restore, feature (Explore filter), recheck, remove', async () => {
  const { h, owner, maker, mod, published } = await world();
  const a = await published(owner, 'Alpha');
  const b = await published(owner, 'Beta');
  const waiting = await published(maker, 'Gamma');
  const list = async (status, q = '') => (await h.request('GET', `/v1/mod/animations?status=${status}${q ? `&q=${q}` : ''}`, { token: mod.token })).data.items.map((item) => item.title);
  assert.deepEqual((await list('published')).sort(), ['Alpha', 'Beta']);
  assert.deepEqual(await list('review'), ['Gamma']);
  assert.deepEqual(await list('published', 'alp'), ['Alpha']);

  const act = (id, action, reason) => h.request('POST', `/v1/mod/animations/${id}/action`, { token: mod.token, json: { action, reason } });
  assert.equal((await act(a, 'feature')).status, 200);
  assert.deepEqual((await h.request('GET', '/v1/animations?feed=featured')).data.items.map((item) => item.title), ['Alpha']);
  assert.equal((await h.request('GET', '/v1/config')).data.featured, 1);
  assert.equal((await act(waiting, 'feature')).data.error.code, 'invalid_state');

  await act(b, 'hide', 'checking credits');
  assert.equal((await h.request('GET', `/v1/animations/${b}`)).status, 404);
  await act(b, 'restore');
  assert.equal((await h.request('GET', `/v1/animations/${b}`)).status, 200);

  await act(waiting, 'restore'); // approve from the list: first publication notifies the uploader
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', waiting).status, 'published');
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM cases WHERE target_id = ? AND status = 'open'", waiting).n, 0);
  assert.equal(h.db.row("SELECT kind FROM notifications WHERE animation_id = ? ORDER BY rowid DESC", waiting).kind, 'published');

  const jobs = h.db.rows("SELECT id FROM pipeline_jobs WHERE subject_id = ?", a).length;
  await act(a, 'recheck');
  assert.equal(h.db.rows("SELECT id FROM pipeline_jobs WHERE subject_id = ?", a).length, jobs + 1);

  await act(a, 'remove', 'Not allowed');
  assert.equal(h.db.row('SELECT status, featured_at FROM animations WHERE id = ?', a).status, 'rejected');
  assert.ok(!h.files.has(`animations/${a}.zip`));
  assert.deepEqual((await h.request('GET', '/v1/animations?feed=featured')).data.items, []);
  assert.equal((await h.request('POST', `/v1/mod/animations/${a}/action`, { token: maker.token, json: { action: 'hide' } })).status, 403);
});
