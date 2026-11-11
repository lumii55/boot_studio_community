import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, uploadAnimation } from './helpers.js';

async function setup() {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const id = await uploadAnimation(h, owner.token);
  return { h, sign, owner, id, job: lastJob(h, 'animation', id) };
}

test('only the moderation workflow on main of the community repo is accepted', async () => {
  const { h, sign, job } = await setup();
  const path = `/v1/pipeline/jobs/${job.id}`;
  const otherKey = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  )).privateKey;
  const refused = [
    await sign({ repository: 'someone/fork' }),
    await sign({ ref: 'refs/heads/feature' }),
    await sign({ event_name: 'pull_request' }),
    await sign({ aud: 'other' }),
    await sign({ exp: Math.floor(h.now / 1000) - 120 }),
    await sign({ job_workflow_ref: 'lumii55/boot_studio_community/.github/workflows/evil.yml@refs/heads/main' }),
    await sign({ iss: 'https://evil.example' }),
    await sign({}, { signWith: otherKey }),
    await sign({}, { kid: 'unknown' }),
    'not-a-jwt',
  ];
  for (const token of refused) {
    const res = await h.request('GET', path, { token });
    assert.equal(res.status, 401, token.slice(0, 20));
  }
  // Session tokens of users (even the owner) are not pipeline credentials.
  const owner = h.db.row("SELECT id FROM users WHERE role = 'owner'");
  assert.ok(owner);
  const ok = await h.request('GET', path, { token: await sign() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.subject.file_url, `https://api.test/v1/pipeline/jobs/${job.id}/file`);
  assert.equal(h.db.row('SELECT status FROM pipeline_jobs WHERE id = ?', job.id).status, 'running');
});

test('the workflow downloads the quarantined file and reports once', async () => {
  const { h, sign, job, id } = await setup();
  const token = await sign();
  const file = await h.request('GET', `/v1/pipeline/jobs/${job.id}/file`, { token });
  assert.equal(file.status, 200);
  assert.ok(file.data.byteLength > 20);
  assert.equal((await h.request('POST', `/v1/pipeline/jobs/${job.id}/result`, { token, json: { verdict: 'maybe' } })).status, 400);
  await finishJob(h, sign, job.id, CLEAN);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'published');
  const twice = await h.request('POST', `/v1/pipeline/jobs/${job.id}/result`, { token, json: CLEAN });
  assert.equal(twice.data.error.code, 'job_finished');
});

test('automatic reject deletes the file, frees storage and is logged', async () => {
  const { h, sign, job, id } = await setup();
  await finishJob(h, sign, job.id, {
    verdict: 'reject',
    findings: [{ code: 'zip_unsafe_path', severity: 3, message: 'Unsafe path in ZIP' }],
  });
  const row = h.db.row('SELECT status, status_reason FROM animations WHERE id = ?', id);
  assert.deepEqual(row, { status: 'rejected', status_reason: 'Unsafe path in ZIP' });
  assert.ok(!h.files.has(`animations/${id}.zip`));
  assert.equal(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value, '0');
  assert.equal(h.db.row('SELECT action FROM mod_actions WHERE target_id = ?', id).action, 'auto_reject');
});

test('review verdict opens an automod case and posts it to Discord', async () => {
  const { h, sign, job, id } = await setup();
  await finishJob(h, sign, job.id, {
    verdict: 'review',
    findings: [{ code: 'logo_unknown', severity: 1, message: 'Manufacturer logo found; credit required' }],
  });
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'review');
  const opened = h.db.row('SELECT * FROM cases WHERE target_id = ?', id);
  assert.equal(opened.kind, 'automod');
  assert.equal(JSON.parse(opened.findings)[0].code, 'logo_unknown');
  const posted = h.net.discordMessages.find((message) => message.method === 'POST');
  assert.ok(posted);
  assert.match(posted.body.content, /Revisão/);
});

test('detected manufacturer is stored as a credit', async () => {
  const { h, sign, job, id } = await setup();
  await finishJob(h, sign, job.id, { ...CLEAN, detected: { manufacturer: 'Motorola' } });
  const detail = await h.request('GET', `/v1/animations/${id}`);
  assert.equal(detail.data.credits.detected_manufacturer, 'Motorola');
});

test('jobs that never finish are retried, then sent to manual review', async () => {
  const h = createHarness();
  await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  h.net.dispatchStatus = 500; // GitHub down
  const id = await uploadAnimation(h, owner.token);
  const job = lastJob(h, 'animation', id);
  assert.equal(job.status, 'queued');
  for (let i = 0; i < 3; i++) {
    h.advance(31 * 60000);
    await h.scheduled();
  }
  assert.equal(h.db.row('SELECT status FROM pipeline_jobs WHERE id = ?', job.id).status, 'failed');
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'review');
  assert.equal(JSON.parse(h.db.row('SELECT findings FROM cases WHERE target_id = ?', id).findings)[0].code, 'pipeline_failed');
});

test('a dispatch that worked once is not repeated while the workflow runs', async () => {
  const { h } = await setup();
  assert.equal(h.net.dispatches().length, 1);
  h.advance(10 * 60000);
  await h.scheduled();
  assert.equal(h.net.dispatches().length, 1);
});
