import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, DAY, fakeZip, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, sha256Hex, uploadAnimation } from './helpers.js';

async function world() {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const mod = await h.signIn('helper');
  await h.request('PUT', '/v1/mod/users/helper/role', { token: owner.token, json: { role: 'moderator' } });
  const publish = async (who, title) => {
    const id = await uploadAnimation(h, who.token, { title });
    await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
    return id;
  };
  return { h, sign, owner, mod, publish };
}

test('internal notes on people and cases; only the author or the owner deletes them', async () => {
  const { h, owner, mod, publish } = await world();
  const person = await h.signIn('person');
  const add = (who, json) => h.request('POST', '/v1/mod/notes', { token: who.token, json });
  assert.equal((await add(person, { target_type: 'user', target_id: 'person', body: 'x' })).status, 403);
  const added = await add(mod, { target_type: 'user', target_id: 'person', body: 'Talked on Discord, will fix credits' });
  assert.equal(added.status, 201);
  assert.equal(added.data.items[0].author, 'helper');
  const file = await h.request('GET', '/v1/mod/users/person', { token: owner.token });
  assert.equal(file.data.notes[0].body, 'Talked on Discord, will fix credits');

  const id = await publish(person, 'Review me');
  const caseRow = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", id);
  await add(owner, { target_type: 'case', target_id: caseRow.id, body: 'Looks fine to me' });
  const listed = await h.request('GET', `/v1/mod/notes?target_type=case&target_id=${caseRow.id}`, { token: mod.token });
  assert.equal(listed.data.items[0].body, 'Looks fine to me');
  const noteId = listed.data.items[0].id;
  assert.equal((await h.request('DELETE', `/v1/mod/notes/${noteId}`, { token: mod.token })).status, 403);
  assert.equal((await h.request('DELETE', `/v1/mod/notes/${added.data.items[0].id}`, { token: owner.token })).status, 200);
});

test('history filters by moderator, action and person', async () => {
  const { h, owner, mod, publish } = await world();
  await h.request('PUT', '/v1/mod/users/helper/permissions', { token: owner.token, json: { permissions: ['warn', 'feature'] } });
  const person = await h.signIn('person');
  const other = await h.signIn('other');
  const theirs = await publish(owner, 'Owner one');
  await h.request('POST', '/v1/mod/users/person/sanctions', { token: mod.token, json: { kind: 'warning', reason: 'a' } });
  await h.request('POST', '/v1/mod/users/other/sanctions', { token: owner.token, json: { kind: 'warning', reason: 'b' } });
  await h.request('POST', `/v1/mod/animations/${theirs}/action`, { token: mod.token, json: { action: 'feature' } });
  const audit = async (query) => (await h.request('GET', `/v1/mod/audit?${query}`, { token: owner.token })).data.items.map((item) => item.action);
  assert.deepEqual(await audit('actor=helper'), ['feature', 'sanction_warning']);
  assert.deepEqual(await audit('action=sanction'), ['sanction_warning', 'sanction_warning']);
  assert.deepEqual(await audit('person=person'), ['sanction_warning']);
  assert.deepEqual(await audit('person=lumii55&action=feature'), ['feature']);
  assert.ok(person && other);
});

test('abusive reporters: many reports, mostly unfounded', async () => {
  const { h, owner, publish } = await world();
  const troll = await h.signIn('troll');
  for (let i = 0; i < 6; i++) {
    const id = await publish(owner, `Fine boot ${i}`);
    await h.request('POST', '/v1/reports', { token: troll.token, json: { target_type: 'animation', target_id: id, category: 'spam', turnstile_token: 'turnstile-ok' } });
    const caseRow = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", id);
    await h.request('POST', `/v1/mod/cases/${caseRow.id}/action`, { token: owner.token, json: { action: 'approve' } });
  }
  const list = await h.request('GET', '/v1/mod/reporters', { token: owner.token });
  assert.deepEqual(list.data.items.map((item) => [item.handle, item.total, item.unfounded]), [['troll', 6, 6]]);
  const file = await h.request('GET', '/v1/mod/users/troll', { token: owner.token });
  assert.deepEqual(file.data.reports_made, { total: 6, unfounded: 6, upheld: 0 });
});

test('30-day charts', async () => {
  const { h, owner, publish } = await world();
  await publish(owner, 'Today');
  await h.request('GET', `/v1/animations/${h.db.row('SELECT id FROM animations').id}/download`);
  const data = (await h.request('GET', '/v1/mod/timeseries', { token: owner.token })).data;
  assert.equal(data.days.length, 30);
  assert.equal(data.uploads.at(-1), 1);
  assert.equal(data.downloads.at(-1), 1);
  assert.equal(data.people.at(-1), 2);
  assert.equal(data.reports.reduce((a, b) => a + b, 0), 0);
});

test('bulk decisions apply per case and report what failed', async () => {
  const { h, owner, mod } = await world();
  const newbie = await h.signIn('newbie');
  const { sign } = await (async () => ({ sign: null }))();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = await uploadAnimation(h, newbie.token, { title: `Bulk ${i}` });
    ids.push(id);
  }
  const signer = (await import('./helpers.js')).oidcSigner;
  const signFn = await signer(h);
  for (const id of ids) await finishJob(h, signFn, lastJob(h, 'animation', id).id, CLEAN);
  const caseIds = ids.map((id) => h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", id).id);
  const denied = await h.request('POST', '/v1/mod/cases/bulk', { token: mod.token, json: { ids: caseIds, action: 'approve' } });
  assert.equal(denied.data.done, 0);
  assert.equal(denied.data.results[0].code, 'no_permission');
  const res = await h.request('POST', '/v1/mod/cases/bulk', { token: owner.token, json: { ids: [...caseIds, 'A'.repeat(16)], action: 'approve' } });
  assert.equal(res.data.done, 3);
  assert.equal(res.data.results.at(-1).code, 'not_found');
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM animations WHERE status = 'published'").n, 3);
  assert.equal(sign, null);
});

test('announcement: needs the permission, shows in the config, can be cleared', async () => {
  const { h, owner, mod } = await world();
  assert.equal((await h.request('PUT', '/v1/mod/announcement', { token: mod.token, json: { text: 'Hi' } })).status, 403);
  await h.request('PUT', '/v1/mod/announcement', { token: owner.token, json: { text: 'Boot animation contest this week! 🎉' } });
  assert.equal((await h.request('GET', '/v1/config')).data.announcement.text, 'Boot animation contest this week! 🎉');
  await h.request('PUT', '/v1/mod/announcement', { token: owner.token, json: { text: null } });
  assert.equal((await h.request('GET', '/v1/config')).data.announcement, null);
});

test('re-check everything queues jobs; the cron starts them a few at a time', async () => {
  const { h, owner, publish } = await world();
  for (let i = 0; i < 12; i++) await publish(owner, `Live ${i}`);
  const before = h.net.dispatches().length;
  const res = await h.request('POST', '/v1/mod/recheck-all', { token: owner.token });
  assert.equal(res.data.queued, 12);
  assert.equal(h.net.dispatches().length, before); // nothing started in the request itself
  await h.scheduled();
  assert.equal(h.net.dispatches().length, before + 10);
  await h.scheduled();
  assert.equal(h.net.dispatches().length, before + 12);
  assert.equal((await h.request('POST', '/v1/mod/recheck-all', { token: owner.token })).data.queued, 0); // already queued
});

test('settings: owner only; size, upload limits, mass threshold, detector and Discord events apply', async () => {
  const { h, owner, mod, sign, publish } = await world();
  assert.equal((await h.request('GET', '/v1/mod/settings', { token: mod.token })).status, 403);
  assert.equal((await h.request('PUT', '/v1/mod/settings', { token: owner.token, json: { max_animation_mb: 80 } })).data.error.code, 'invalid_setting');
  const saved = await h.request('PUT', '/v1/mod/settings', { token: owner.token, json: {
    max_animation_mb: 1, uploads_per_hour: 1, mass_report_threshold: 2, detector: 'strict', discord_events: { review: false },
  } });
  assert.equal(saved.data.detector, 'strict');
  assert.equal((await h.request('GET', '/v1/config')).data.limits.animation_bytes, 1024 * 1024);

  const maker = await h.signIn('maker');
  const big = new Uint8Array(1024 * 1024 + 10);
  const tooBig = await h.request('POST', '/v1/animations', { token: maker.token, json: {
    title: 'Too big', license: 'cc0-1.0', sha256: await sha256Hex(big), size_bytes: big.byteLength, turnstile_token: 'turnstile-ok',
  } });
  assert.equal(tooBig.data.error.code, 'too_large');
  const id = await uploadAnimation(h, maker.token, { title: 'First' });
  const job = await (async () => {
    const token = await sign();
    return (await h.request('GET', `/v1/pipeline/jobs/${lastJob(h, 'animation', id).id}`, { token })).data;
  })();
  assert.equal(job.sensitivity, 'strict');
  const second = fakeZip('second');
  const limited = await h.request('POST', '/v1/animations', { token: maker.token, json: {
    title: 'Second', license: 'cc0-1.0', sha256: await sha256Hex(second), size_bytes: second.byteLength, turnstile_token: 'turnstile-ok',
  } });
  assert.equal(limited.status, 429);

  // Review notices are off for Discord; mass reports still post.
  const posted = h.net.discordMessages.length;
  await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN); // → review case, not posted
  assert.equal(h.net.discordMessages.length, posted);
  const live = await publish(owner, 'Reported twice');
  for (const name of ['r1', 'r2']) {
    const who = await h.signIn(name);
    await h.request('POST', '/v1/reports', { token: who.token, json: { target_type: 'animation', target_id: live, category: 'spam', turnstile_token: 'turnstile-ok' } });
  }
  assert.equal(h.db.row("SELECT mass FROM cases WHERE target_id = ? AND status = 'open'", live).mass, 1);
  assert.ok(h.net.discordMessages.length > posted);
});

test('LGPD export: needs the permission and contains the person\'s data', async () => {
  const { h, owner, mod, publish } = await world();
  const person = await h.signIn('person');
  await publish(person, 'Mine');
  await h.request('PATCH', '/v1/me', { token: person.token, json: { bio: 'my bio' } });
  assert.equal((await h.request('GET', '/v1/mod/users/person/export', { token: mod.token })).status, 403);
  const res = await h.request('GET', '/v1/mod/users/person/export', { token: owner.token });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Disposition'), /bas-community-person\.json/);
  assert.equal(res.data.profile.bio, 'my bio');
  assert.equal(res.data.animations[0].title, 'Mine');
  assert.ok(!('id' in res.data.profile));
  assert.equal(h.db.row("SELECT action FROM mod_actions WHERE action = 'export'").action, 'export');
  assert.ok(DAY);
});
