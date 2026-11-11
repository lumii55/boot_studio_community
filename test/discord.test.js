import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEAN, createHarness, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, uploadAnimation } from './helpers.js';

async function discordWorld() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicHex = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');
  const h = createHarness({ env: { DISCORD_PUBLIC_KEY: publicHex } });
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const newbie = await h.signIn('newbie');
  const id = await uploadAnimation(h, newbie.token, { title: 'Hello @everyone' });
  await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
  const caseRow = h.db.row("SELECT * FROM cases WHERE target_id = ? AND status = 'open'", id);

  const interact = async (payload, { tamper = false, timestamp } = {}) => {
    const body = JSON.stringify(payload);
    const ts = String(timestamp ?? Math.floor(h.now / 1000));
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(ts + body))).toString('hex');
    return h.request('POST', '/v1/discord/interactions', {
      raw: new TextEncoder().encode(tamper ? body.replace('do:', 'dX:') : body),
      headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': ts, 'Content-Type': 'application/json' },
    });
  };
  const click = (discordId, customId) => interact({ type: 3, member: { user: { id: discordId } }, data: { custom_id: customId } });
  return { h, owner, newbie, id, caseRow, interact, click };
}

test('a new case is posted with action buttons, a panel link and no mentions', async () => {
  const { h, caseRow } = await discordWorld();
  const posted = h.net.discordMessages.filter((message) => message.method === 'POST');
  assert.equal(posted.length, 1);
  const message = posted[0].body;
  assert.equal(posted[0].path, '/api/v10/channels/123456789012345678/messages');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  const buttons = message.components[0].components;
  assert.deepEqual(buttons.map((button) => button.label), ['Aprovar', 'Ocultar', 'Remover', 'Banir o autor', 'Abrir no painel']);
  assert.equal(buttons[0].custom_id, `do:approve:${caseRow.id}`);
  assert.equal(buttons[2].custom_id, `ask:remove:${caseRow.id}`);
  assert.equal(buttons[4].url, `https://site.test/bas/#community/mod/case/${caseRow.id}`);
  assert.equal(h.db.row('SELECT message_id FROM discord_messages WHERE case_id = ?', caseRow.id).message_id, '1000');
});

test('interactions: signature required, PING answered, replays refused', async () => {
  const { h, interact } = await discordWorld();
  assert.deepEqual((await interact({ type: 1 })).data, { type: 1 });
  assert.equal((await interact({ type: 1 }, { tamper: true })).status, 200); // body unchanged by tamper (no "do:")
  const tampered = await interact({ type: 3, data: { custom_id: 'do:approve:x' } }, { tamper: true });
  assert.equal(tampered.status, 401);
  const old = await interact({ type: 1 }, { timestamp: Math.floor(h.now / 1000) - 600 });
  assert.equal(old.status, 401);
  const unsigned = await h.request('POST', '/v1/discord/interactions', { raw: new TextEncoder().encode('{"type":1}') });
  assert.equal(unsigned.status, 401);
});

test('buttons only work for linked moderators; remove asks for confirmation first', async () => {
  const { h, owner, id, caseRow, click } = await discordWorld();
  const stranger = await click('999999999999999999', `do:approve:${caseRow.id}`);
  assert.equal(stranger.data.data.flags, 64);
  assert.match(stranger.data.data.content, /Só moderadores/);

  await h.request('PUT', '/v1/mod/users/lumii55/discord', { token: owner.token, json: { discord_id: '111111111111111111' } });
  const ask = await click('111111111111111111', `ask:remove:${caseRow.id}`);
  assert.match(ask.data.data.content, /Tem certeza/);
  assert.equal(ask.data.data.components[0].components[0].custom_id, `do:remove:${caseRow.id}`);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'review'); // nothing happened yet

  const done = await click('111111111111111111', `do:approve:${caseRow.id}`);
  assert.match(done.data.data.content, /Aprovar por @lumii55/);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'published');
  const log = h.db.row("SELECT source, actor_id FROM mod_actions WHERE action = 'approve'");
  assert.deepEqual(log, { source: 'discord', actor_id: owner.user.id });
  // The channel message was edited to the decided state (no action buttons left).
  const edit = h.net.discordMessages.filter((message) => message.method === 'PATCH').pop();
  assert.equal(edit.body.content, '✅ Decidido');
  assert.deepEqual(edit.body.components[0].components.map((button) => button.label), ['Abrir no painel']);

  const late = await click('111111111111111111', `do:remove:${caseRow.id}`);
  assert.match(late.data.data.content, /already decided/);
});

test('without bot configuration nothing is sent and nothing breaks', async () => {
  const h = createHarness({ env: { DISCORD_BOT_TOKEN: '' } });
  const sign = await oidcSigner(h);
  const newbie = await h.signIn('newbie');
  const id = await uploadAnimation(h, newbie.token);
  await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
  assert.equal(h.net.discordMessages.length, 0);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'review');
});
