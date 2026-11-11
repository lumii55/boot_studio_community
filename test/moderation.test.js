import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, fakeZip, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, sha256Hex, uploadAnimation } from './helpers.js';

async function world() {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const creator = await h.signIn('creator');
  h.db.sqlite.prepare('UPDATE users SET trust = 1 WHERE id = ?').run(creator.user.id);
  const id = await uploadAnimation(h, creator.token, { title: 'Reported boot' });
  await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
  const reporters = [];
  for (let i = 0; i < 4; i++) reporters.push(await h.signIn(`reporter${i}`));
  const report = (who, category = 'spam', target = { target_type: 'animation', target_id: id }) =>
    h.request('POST', '/v1/reports', { token: who.token, json: { ...target, category, note: 'look', turnstile_token: 'turnstile-ok' } });
  const queue = async (tab) => (await h.request('GET', `/v1/mod/queue?tab=${tab}`, { token: owner.token })).data.items;
  return { h, sign, owner, creator, id, reporters, report, queue };
}

test('a single report lands in the reports tab; nothing is hidden', async () => {
  const { h, id, reporters, report, queue } = await world();
  assert.equal((await report(reporters[0])).status, 201);
  const items = await queue('reports');
  assert.equal(items.length, 1);
  assert.equal(items[0].target_id, id);
  assert.equal(items[0].report_count, 1);
  assert.equal((await queue('mass')).length, 0);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'published');
  assert.equal((await report(reporters[0])).data.error.code, 'already_reported');
});

test('a single critical report goes to the top and triggers a new automatic check', async () => {
  const { h, sign, owner, creator, id, reporters, report, queue } = await world();
  const other = await uploadAnimation(h, creator.token, { title: 'Other' });
  await finishJob(h, sign, lastJob(h, 'animation', other).id, CLEAN);
  await report(reporters[0], 'spam', { target_type: 'animation', target_id: other });
  h.advance(1000);
  const jobsBefore = h.db.rows("SELECT id FROM pipeline_jobs WHERE subject_id = ?", id).length;
  await report(reporters[1], 'nudity');
  const items = await queue('reports');
  assert.deepEqual(items.map((item) => item.target_id), [id, other]);
  assert.equal(items[0].max_severity, 3);
  assert.equal(h.db.rows("SELECT id FROM pipeline_jobs WHERE subject_id = ?", id).length, jobsBefore + 1);
  const summary = await h.request('GET', '/v1/mod/summary', { token: owner.token });
  assert.deepEqual(summary.data, { mass: 0, reports: 2, critical_reports: 1, review: 0 });
  const discord = h.net.discordMessages.filter((message) => message.method === 'POST').map((message) => message.body.content);
  assert.ok(discord.includes('⚠️ Denúncia grave'));

  // The re-check rejects it: hidden at once, still waiting for a person.
  await finishJob(h, sign, lastJob(h, 'animation', id).id, { verdict: 'reject', findings: [{ code: 'nsfw', severity: 3, message: 'Nudity detected' }] });
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'hidden');
  const opened = h.db.row("SELECT * FROM cases WHERE target_id = ? AND status = 'open'", id);
  assert.equal(opened.auto_hidden, 1);
  assert.equal(opened.report_count, 1);
});

test('reports from 3 different accounts: mass tab, hidden until decided; approve restores', async () => {
  const { h, owner, id, reporters, report, queue } = await world();
  for (const reporter of reporters.slice(0, 3)) await report(reporter);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'hidden');
  assert.equal((await h.request('GET', `/v1/animations/${id}`)).status, 404);
  const mass = await queue('mass');
  assert.equal(mass.length, 1);
  assert.equal(mass[0].auto_hidden, true);
  assert.equal((await queue('reports')).length, 0);

  const detail = await h.request('GET', `/v1/mod/cases/${mass[0].id}`, { token: owner.token });
  assert.equal(detail.data.reports.length, 3);
  assert.equal(detail.data.history[0].action, 'auto_hide');

  const res = await h.request('POST', `/v1/mod/cases/${mass[0].id}/action`, { token: owner.token, json: { action: 'approve', reason: 'fine' } });
  assert.equal(res.status, 200);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'published');
  assert.equal((await queue('mass')).length, 0);
  const again = await h.request('POST', `/v1/mod/cases/${mass[0].id}/action`, { token: owner.token, json: { action: 'hide' } });
  assert.equal(again.data.error.code, 'case_closed');
});

test('remove deletes the files and blocks the same file from coming back', async () => {
  const { h, owner, creator, id, reporters, report, queue } = await world();
  await report(reporters[0], 'uncredited');
  const [item] = await queue('reports');
  await h.request('POST', `/v1/mod/cases/${item.id}/action`, { token: owner.token, json: { action: 'remove', reason: 'stolen' } });
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'rejected');
  assert.ok(!h.files.has(`animations/${id}.zip`));
  const row = h.db.row('SELECT sha256, size_bytes FROM animations WHERE id = ?', id);
  const retry = await h.request('POST', '/v1/animations', {
    token: creator.token,
    json: { title: 'Again', license: 'cc0-1.0', sha256: row.sha256, size_bytes: row.size_bytes, turnstile_token: 'turnstile-ok' },
  });
  assert.equal(retry.data.error.code, 'file_rejected');
  const audit = await h.request('GET', '/v1/mod/audit', { token: owner.token });
  assert.equal(audit.data.items[0].action, 'remove');
  assert.equal(audit.data.items[0].actor, 'lumii55');
});

test('ban: sessions end, uploads are hidden; the owner cannot be banned', async () => {
  const { h, owner, creator, id, reporters, report, queue } = await world();
  await report(reporters[0], 'hate');
  const [item] = await queue('reports');
  await h.request('POST', `/v1/mod/cases/${item.id}/action`, { token: owner.token, json: { action: 'ban' } });
  assert.equal((await h.request('GET', '/v1/me', { token: creator.token })).status, 401);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'hidden');
  assert.equal(h.db.row('SELECT status FROM users WHERE id = ?', creator.user.id).status, 'banned');

  // A moderator cannot ban the owner through a report on the owner's profile.
  await h.request('PUT', '/v1/mod/users/reporter1/role', { token: owner.token, json: { role: 'moderator' } });
  await report(reporters[2], 'other', { target_type: 'user', target_id: 'lumii55' });
  const [ownerCase] = await queue('reports');
  const refused = await h.request('POST', `/v1/mod/cases/${ownerCase.id}/action`, { token: reporters[1].token, json: { action: 'ban' } });
  assert.equal(refused.status, 403);
});

test('only moderators see the panel; only the owner manages the team', async () => {
  const { h, owner, reporters } = await world();
  const user = reporters[0];
  for (const path of ['/v1/mod/queue?tab=mass', '/v1/mod/summary', '/v1/mod/audit']) {
    assert.equal((await h.request('GET', path, { token: user.token })).status, 403);
  }
  assert.equal((await h.request('PUT', '/v1/mod/users/reporter1/role', { token: user.token, json: { role: 'moderator' } })).status, 403);
  assert.equal((await h.request('PUT', '/v1/mod/users/reporter0/role', { token: owner.token, json: { role: 'moderator' } })).status, 200);
  assert.equal((await h.request('GET', '/v1/mod/summary', { token: user.token })).status, 200);
  assert.equal((await h.request('PUT', '/v1/mod/users/reporter1/role', { token: user.token, json: { role: 'moderator' } })).status, 403);
  assert.equal((await h.request('PUT', '/v1/mod/users/lumii55/role', { token: owner.token, json: { role: 'user' } })).status, 404);
  assert.equal((await h.request('PUT', '/v1/mod/users/reporter0/discord', { token: owner.token, json: { discord_id: 'abc' } })).status, 400);
  assert.equal((await h.request('PUT', '/v1/mod/users/reporter0/discord', { token: owner.token, json: { discord_id: '123456789012345678' } })).status, 200);
  const listed = await h.request('GET', '/v1/mod/team', { token: user.token });
  assert.deepEqual(listed.data.items.map((item) => [item.handle, item.role, item.discord_linked]), [['lumii55', 'owner', false], ['reporter0', 'moderator', true]]);
  assert.equal((await h.request('PUT', '/v1/mod/users/reporter1/discord', { token: owner.token, json: { discord_id: '123456789012345678' } })).data.error.code, 'discord_in_use');
});

test('reports need sign-in, a reason, the anti-robot check, and not your own content', async () => {
  const { h, creator, id, reporters, report } = await world();
  assert.equal((await h.request('POST', '/v1/reports', { json: { target_type: 'animation', target_id: id, category: 'spam' } })).status, 401);
  assert.equal((await report(reporters[0], 'boring')).data.error.code, 'invalid_category');
  const noRobotCheck = await h.request('POST', '/v1/reports', { token: reporters[0].token, json: { target_type: 'animation', target_id: id, category: 'spam' } });
  assert.equal(noRobotCheck.data.error.code, 'turnstile_required');
  assert.equal((await report(creator)).data.error.code, 'own_content');
});

test('a new uploader approved by a moderator becomes trusted (if the GitHub account is old enough)', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const veteran = await h.signIn('veteran', { createdDaysAgo: 365 });
  const fresh = await h.signIn('fresh', { createdDaysAgo: 3 });
  for (const who of [veteran, fresh]) {
    const id = await uploadAnimation(h, who.token, { title: `${who.user.handle} first` });
    await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
    const opened = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", id);
    await h.request('POST', `/v1/mod/cases/${opened.id}/action`, { token: owner.token, json: { action: 'approve' } });
    assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'published');
  }
  assert.equal(h.db.row('SELECT trust FROM users WHERE id = ?', veteran.user.id).trust, 1);
  assert.equal(h.db.row('SELECT trust FROM users WHERE id = ?', fresh.user.id).trust, 0);
  const bytes = fakeZip('second');
  const second = await uploadAnimation(h, veteran.token, { title: 'Second', bytes });
  await finishJob(h, sign, lastJob(h, 'animation', second).id, CLEAN);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', second).status, 'published');
  assert.ok(await sha256Hex(bytes));
});
