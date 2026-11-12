import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, DAY, fakeZip, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, sha256Hex, uploadAnimation } from './helpers.js';

async function world() {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const mod = await h.signIn('helper');
  const user = await h.signIn('person');
  h.db.sqlite.prepare("UPDATE users SET trust = 1 WHERE handle = 'person'").run();
  const promote = (permissions) => h.request('PUT', '/v1/mod/users/helper/role', { token: owner.token, json: { role: 'moderator', permissions } });
  const punish = (who, json) => h.request('POST', '/v1/mod/users/person/sanctions', { token: who.token, json });
  const file = async (who = owner) => (await h.request('GET', '/v1/mod/users/person', { token: who.token })).data;
  const publish = async (who, title) => {
    const id = await uploadAnimation(h, who.token, { title });
    await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
    return id;
  };
  const inbox = async (who) => (await h.request('GET', '/v1/me/notifications', { token: who.token })).data.items;
  return { h, sign, owner, mod, user, promote, punish, file, publish, inbox };
}

async function draft(h, who, label = 'x') {
  const bytes = fakeZip(label);
  return h.request('POST', '/v1/animations', { token: who.token, json: {
    title: `Draft ${label}`, license: 'cc0-1.0', sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength, turnstile_token: 'turnstile-ok',
  } });
}

test('moderators start with no permissions; the owner ticks them one by one', async () => {
  const { h, owner, mod, promote, punish } = await world();
  await promote(undefined);
  assert.deepEqual((await h.request('GET', '/v1/me', { token: mod.token })).data.permissions, []);
  assert.equal((await h.request('GET', '/v1/mod/summary', { token: mod.token })).status, 200); // can see the panel
  const denied = await punish(mod, { kind: 'warning', reason: 'be nice' });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'no_permission');

  const set = await h.request('PUT', '/v1/mod/users/helper/permissions', { token: owner.token, json: { permissions: ['warn', 'nonsense'] } });
  assert.deepEqual(set.data.permissions, ['warn']);
  assert.equal((await punish(mod, { kind: 'warning', reason: 'be nice' })).status, 201);
  assert.equal((await punish(mod, { kind: 'ban', reason: 'x' })).status, 403);
  const team = await h.request('GET', '/v1/mod/team', { token: mod.token });
  assert.deepEqual(team.data.items.find((item) => item.handle === 'helper').permissions, ['warn']);
  assert.ok(team.data.permissions.includes('ban'));
  // Re-promoting without a list keeps the permissions; leaving the team clears them.
  await promote(undefined);
  assert.deepEqual((await h.request('GET', '/v1/me', { token: mod.token })).data.permissions, ['warn']);
  await h.request('PUT', '/v1/mod/users/helper/role', { token: owner.token, json: { role: 'user' } });
  await promote(undefined);
  assert.deepEqual((await h.request('GET', '/v1/me', { token: mod.token })).data.permissions, []);
  assert.equal((await h.request('PUT', '/v1/mod/users/helper/permissions', { token: mod.token, json: { permissions: ['ban'] } })).status, 403);
});

test('case decisions and Discord buttons need the matching permission', async () => {
  const { h, owner, mod, promote, publish } = await world();
  const newbie = await h.signIn('newbie');
  const id = await publish(newbie, 'Needs review');
  const caseRow = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", id);
  await promote([]);
  const denied = await h.request('POST', `/v1/mod/cases/${caseRow.id}/action`, { token: mod.token, json: { action: 'approve' } });
  assert.equal(denied.data.error.code, 'no_permission');
  await promote(['review']);
  assert.equal((await h.request('POST', `/v1/mod/cases/${caseRow.id}/action`, { token: mod.token, json: { action: 'approve' } })).status, 200);
  assert.ok(owner);
});

test('a warning notifies, counts as a strike and blocks nothing', async () => {
  const { h, owner, user, punish, file, inbox } = await world();
  assert.equal((await punish(owner, { kind: 'warning' })).data.error.code, 'invalid_length'); // a reason is required
  assert.equal((await punish(owner, { kind: 'warning', reason: 'Please credit the artist' })).status, 201);
  const notice = (await inbox(user))[0];
  assert.equal(notice.kind, 'sanction');
  assert.equal(notice.reason, 'Please credit the artist');
  assert.equal(notice.data.sanction, 'warning');
  assert.equal((await draft(h, user)).status, 201);
  const data = await file();
  assert.equal(data.strikes.count, 1);
  assert.equal(data.strikes.window_days, 365);
  assert.equal(data.sanctions[0].kind, 'warning');
});

test('restrictions block only the chosen actions, end by themselves and can be lifted', async () => {
  const { h, owner, user, punish, file, publish } = await world();
  const live = await publish(owner, 'Owner boot');
  const res = await punish(owner, { kind: 'restrict', restrictions: ['upload', 'report'], days: 7, reason: 'Spam uploads' });
  assert.equal(res.status, 201);
  const blocked = await draft(h, user, 'r1');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'restricted');
  assert.equal(blocked.data.error.details.until, h.now + 7 * DAY);
  const report = await h.request('POST', '/v1/reports', { token: user.token, json: { target_type: 'animation', target_id: live, category: 'spam', turnstile_token: 'turnstile-ok' } });
  assert.equal(report.data.error.code, 'restricted');
  assert.equal((await h.request('PUT', `/v1/animations/${live}/rating`, { token: user.token, json: { stars: 4 } })).status, 200); // not restricted
  assert.equal((await h.request('PATCH', '/v1/me', { token: user.token, json: { bio: 'hi' } })).status, 200);

  h.advance(7 * DAY + 1000);
  assert.equal((await draft(h, user, 'r2')).status, 201);

  await punish(owner, { kind: 'restrict', restrictions: ['profile'], reason: 'Offensive bio' }); // permanent
  assert.equal((await h.request('PATCH', '/v1/me', { token: user.token, json: { bio: 'again' } })).data.error.code, 'restricted');
  const active = (await file()).sanctions.find((item) => item.active);
  assert.equal(active.ends_at, null);
  assert.equal((await h.request('POST', `/v1/mod/sanctions/${active.id}/revoke`, { token: owner.token, json: { reason: 'Talked it out' } })).status, 200);
  assert.equal((await h.request('PATCH', '/v1/me', { token: user.token, json: { bio: 'again' } })).status, 200);
});

test('suspension: signed out, cannot sign in, uploads stay visible by default; it ends by itself', async () => {
  const { h, owner, user, punish, publish, inbox } = await world();
  const theirs = await publish(user, 'Person boot');
  assert.equal((await punish(owner, { kind: 'suspend', reason: 'Harassment' })).data.error.code, 'invalid_duration');
  assert.equal((await punish(owner, { kind: 'suspend', days: 3, reason: 'Harassment' })).status, 201);
  // The old session explains the punishment once (kind, reason, until, contact), then ends.
  const restricted = await h.request('GET', '/v1/me', { token: user.token });
  assert.equal(restricted.status, 403);
  assert.equal(restricted.data.error.code, 'account_restricted');
  assert.equal(restricted.data.error.details.kind, 'suspend');
  assert.equal(restricted.data.error.details.reason, 'Harassment');
  assert.equal(restricted.data.error.details.until, h.now + 3 * DAY);
  assert.equal(restricted.data.error.details.contact, 'bootanimstudio@gmail.com');
  assert.equal((await h.request('GET', '/v1/me', { token: user.token })).status, 401);
  await assert.rejects(h.signIn('person'), /bas-auth-error=suspended/);
  assert.equal((await h.request('GET', `/v1/animations/${theirs}`)).status, 200); // still visible

  h.advance(3 * DAY + 1000);
  await h.scheduled();
  const back = await h.signIn('person');
  assert.equal((await h.request('GET', '/v1/me', { token: back.token })).status, 200);
  assert.deepEqual((await inbox(back)).slice(0, 2).map((item) => item.kind), ['sanction_end', 'sanction']);
});

test('suspension with "hide uploads until it ends", lifted early', async () => {
  const { h, owner, punish, publish, file } = await world();
  const person = h.db.row("SELECT * FROM users WHERE handle = 'person'");
  const token = (await h.signIn('person')).token;
  const theirs = await publish({ token }, 'Hidden while suspended');
  await punish(owner, { kind: 'suspend', days: 30, hide_uploads: true, reason: 'Stolen art' });
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', theirs).status, 'hidden');
  const sanction = (await file()).sanctions[0];
  await h.request('POST', `/v1/mod/sanctions/${sanction.id}/revoke`, { token: owner.token, json: {} });
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', theirs).status, 'published');
  assert.equal(h.db.row('SELECT suspended_until FROM users WHERE id = ?', person.id).suspended_until, null);
  assert.equal((await h.request('POST', `/v1/mod/sanctions/${sanction.id}/revoke`, { token: owner.token, json: {} })).data.error.code, 'already_revoked');
});

test('ban from a case is recorded as a punishment; strikes suggest the next step', async () => {
  const { h, owner, user, punish, file, publish } = await world();
  const theirs = await publish(user, 'Reported boot');
  const reporter = await h.signIn('reporter');
  await h.request('POST', '/v1/reports', { token: reporter.token, json: { target_type: 'animation', target_id: theirs, category: 'hate', turnstile_token: 'turnstile-ok' } });
  for (const reason of ['one', 'two']) await punish(owner, { kind: 'warning', reason });
  assert.equal((await file()).strikes.suggestion, 'restrict');
  await punish(owner, { kind: 'warning', reason: 'three' });
  assert.equal((await file()).strikes.suggestion, 'suspend');
  const caseRow = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", theirs);
  await h.request('POST', `/v1/mod/cases/${caseRow.id}/action`, { token: owner.token, json: { action: 'ban', reason: 'Hate symbol' } });
  const data = await file();
  assert.equal(data.status, 'banned');
  assert.equal(data.sanctions[0].kind, 'ban');
  assert.equal(data.sanctions[0].reason, 'Hate symbol');
  assert.equal(data.strikes.suggestion, null);
  // A year later the old strikes no longer count (the history keeps them).
  h.advance(366 * DAY);
  const later = await h.signIn('lumii55', { id: OWNER_GITHUB_ID }); // sessions last 30 days
  assert.equal((await file(later)).strikes.count, 0);
  assert.equal((await file(later)).sanctions.length, 4);
  assert.ok(user);
});

test('clear profile from the person file needs its permission', async () => {
  const { h, owner, mod, user, promote } = await world();
  await h.request('PATCH', '/v1/me', { token: user.token, json: { display_name: 'Rude Name', bio: 'rude bio' } });
  await promote([]);
  assert.equal((await h.request('POST', '/v1/mod/users/person/action', { token: mod.token, json: { action: 'clear_profile' } })).status, 403);
  await promote(['clear_profile']);
  assert.equal((await h.request('POST', '/v1/mod/users/person/action', { token: mod.token, json: { action: 'clear_profile', reason: 'Offensive' } })).status, 200);
  assert.deepEqual(h.db.row("SELECT display_name, bio FROM users WHERE handle = 'person'"), { display_name: 'person', bio: '' });
  assert.ok(owner);
});

test('nobody punishes the owner, themselves, or (unless owner) another moderator', async () => {
  const { h, owner, mod, promote } = await world();
  await promote(['warn', 'ban']);
  assert.equal((await h.request('POST', '/v1/mod/users/lumii55/sanctions', { token: mod.token, json: { kind: 'warning', reason: 'x' } })).status, 403);
  assert.equal((await h.request('POST', '/v1/mod/users/helper/sanctions', { token: mod.token, json: { kind: 'warning', reason: 'x' } })).status, 400);
  const other = await h.signIn('other');
  await h.request('PUT', '/v1/mod/users/other/role', { token: owner.token, json: { role: 'moderator' } });
  assert.equal((await h.request('POST', '/v1/mod/users/other/sanctions', { token: mod.token, json: { kind: 'warning', reason: 'x' } })).status, 403);
  assert.equal((await h.request('POST', '/v1/mod/users/other/sanctions', { token: owner.token, json: { kind: 'warning', reason: 'x' } })).status, 201);
  assert.ok(other);
});
