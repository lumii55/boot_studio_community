import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLEAN, createHarness, DAY, fakeZip, finishJob, lastJob, oidcSigner, OWNER_GITHUB_ID, sha256Hex, uploadAnimation, webpBytes,
} from './helpers.js';

async function draftBody(bytes, extra = {}) {
  return {
    title: 'My boot', license: 'cc-by-4.0', sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength,
    turnstile_token: 'turnstile-ok', ...extra,
  };
}

test('draft validation: title, license, size limit, anti-robot check', async () => {
  const h = createHarness();
  const { token } = await h.signIn('maker');
  const bytes = fakeZip();
  const cases = [
    [{ title: 'ab' }, 400, 'invalid_length'],
    [{ license: 'mine' }, 400, 'invalid_license'],
    [{ size_bytes: 50 * 1024 * 1024 + 1 }, 413, 'too_large'],
    [{ sha256: 'xyz' }, 400, 'invalid_sha256'],
    [{ turnstile_token: undefined }, 400, 'turnstile_required'],
    [{ turnstile_token: 'bot' }, 403, 'turnstile_failed'],
    [{ tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, 400, 'too_many_tags'],
  ];
  for (const [override, status, code] of cases) {
    const res = await h.request('POST', '/v1/animations', { token, json: await draftBody(bytes, override) });
    assert.equal(res.status, status, JSON.stringify(override));
    assert.equal(res.data.error.code, code);
  }
  assert.equal((await h.request('POST', '/v1/animations', { json: await draftBody(bytes) })).status, 401);
});

test('upload streams to R2, verifies the hash, reserves storage and starts the checks', async () => {
  const h = createHarness();
  const { token } = await h.signIn('maker');
  const bytes = fakeZip();
  const draft = await h.request('POST', '/v1/animations', { token, json: await draftBody(bytes, { tags: ['Néon Lights', 'neon lights'] }) });
  assert.equal(draft.status, 201);

  const wrongSize = await h.request('PUT', `/v1/animations/${draft.data.id}/file`, { token, raw: bytes.slice(1) });
  assert.equal(wrongSize.data.error.code, 'size_mismatch');
  const damaged = bytes.slice();
  damaged[10] ^= 1;
  const bad = await h.request('PUT', `/v1/animations/${draft.data.id}/file`, { token, raw: damaged });
  assert.equal(bad.data.error.code, 'checksum_mismatch');
  assert.equal(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value, '0');

  const ok = await h.request('PUT', `/v1/animations/${draft.data.id}/file`, { token, raw: bytes });
  assert.equal(ok.status, 202);
  assert.ok(h.files.has(`animations/${draft.data.id}.zip`));
  assert.equal(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value, String(bytes.byteLength));
  const row = h.db.row('SELECT status, tags FROM animations WHERE id = ?', draft.data.id);
  assert.equal(row.status, 'scanning');
  assert.deepEqual(JSON.parse(row.tags), ['neon-lights']);
  const job = lastJob(h, 'animation', draft.data.id);
  assert.equal(job.status, 'dispatched');
  assert.deepEqual(h.net.dispatches(), [job.id]);
  const again = await h.request('PUT', `/v1/animations/${draft.data.id}/file`, { token, raw: bytes });
  assert.equal(again.data.error.code, 'already_uploaded');
});

test('the same file cannot be published twice; a refused file stays refused', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const { token } = await h.signIn('maker');
  const bytes = fakeZip('dup');
  const id = await uploadAnimation(h, token, { bytes });
  const dup = await h.request('POST', '/v1/animations', { token, json: await draftBody(bytes) });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'duplicate');

  await finishJob(h, sign, lastJob(h, 'animation', id).id, { verdict: 'reject', findings: [{ code: 'nudity', severity: 3, message: 'Nudity' }] });
  const refused = await h.request('POST', '/v1/animations', { token, json: await draftBody(bytes) });
  assert.equal(refused.data.error.code, 'file_rejected');
});

test('global storage guard pauses uploads before the limit', async () => {
  const h = createHarness({ env: { STORAGE_LIMIT_BYTES: '150' } });
  const { token } = await h.signIn('maker');
  await uploadAnimation(h, token, { bytes: fakeZip('a') }); // ~90 bytes
  const bytes = fakeZip('b');
  const draft = await h.request('POST', '/v1/animations', { token, json: await draftBody(bytes) });
  assert.equal(draft.status, 201); // not yet over the limit
  const put = await h.request('PUT', `/v1/animations/${draft.data.id}/file`, { token, raw: bytes });
  assert.equal(put.status, 507);
  assert.equal(put.data.error.code, 'uploads_paused');
  assert.ok(!h.files.has(`animations/${draft.data.id}.zip`));
  const config = await h.request('GET', '/v1/config');
  assert.equal(config.data.uploads_open, true); // 90 < 150; the guard only refuses what would cross it
});

test('upload rate limit', async () => {
  const h = createHarness();
  const { token } = await h.signIn('maker');
  for (let i = 0; i < 5; i++) {
    assert.equal((await h.request('POST', '/v1/animations', { token, json: await draftBody(fakeZip(`r${i}`)) })).status, 201);
  }
  const limited = await h.request('POST', '/v1/animations', { token, json: await draftBody(fakeZip('r6')) });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
});

test('new uploaders go to review; trusted ones publish when clean; feeds only show published', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const newbie = await h.signIn('newbie');

  const a = await uploadAnimation(h, owner.token, { title: 'Owner boot' });
  await finishJob(h, sign, lastJob(h, 'animation', a).id, CLEAN);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', a).status, 'published');

  const b = await uploadAnimation(h, newbie.token, { title: 'Newbie boot' });
  await finishJob(h, sign, lastJob(h, 'animation', b).id, CLEAN);
  assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', b).status, 'review');
  const opened = h.db.row("SELECT kind, status FROM cases WHERE target_id = ?", b);
  assert.deepEqual(opened, { kind: 'review', status: 'open' });

  const feed = await h.request('GET', '/v1/animations?feed=new');
  assert.deepEqual(feed.data.items.map((item) => item.id), [a]);
  assert.equal(feed.data.items[0].width, 1080);
  assert.equal(feed.data.items[0].owner.handle, 'lumii55');
  // Hidden from strangers, visible to its uploader with the status.
  assert.equal((await h.request('GET', `/v1/animations/${b}`)).status, 404);
  const own = await h.request('GET', `/v1/animations/${b}`, { token: newbie.token });
  assert.equal(own.data.status, 'review');
});

test('feeds: filters, search, pagination and the following feed', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const fan = await h.signIn('fan');
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const id = await uploadAnimation(h, owner.token, { title: `Boot ${i}`, tags: i % 2 ? ['odd'] : ['even'] });
    const meta = i < 3 ? { ...CLEAN.metadata, width: 720, height: 1600 } : CLEAN.metadata;
    await finishJob(h, sign, lastJob(h, 'animation', id).id, { ...CLEAN, metadata: meta });
    ids.push(id);
    h.advance(1000);
  }
  const first = await h.request('GET', '/v1/animations?feed=new');
  assert.equal(first.data.items.length, 24);
  assert.equal(first.data.items[0].id, ids[29]);
  const second = await h.request('GET', `/v1/animations?feed=new&cursor=${first.data.next_cursor}`);
  assert.equal(second.data.items.length, 6);
  assert.equal(second.data.next_cursor, null);
  assert.equal(new Set([...first.data.items, ...second.data.items].map((item) => item.id)).size, 30);

  assert.equal((await h.request('GET', '/v1/animations?tag=odd&limit=48')).data.items.length, 15);
  assert.equal((await h.request('GET', '/v1/animations?res=720x1600')).data.items.length, 3);
  assert.deepEqual((await h.request('GET', '/v1/animations?q=Boot%2012')).data.items.map((item) => item.id), [ids[12]]);
  assert.equal((await h.request('GET', '/v1/animations?q=100%25')).data.items.length, 0);

  assert.equal((await h.request('GET', '/v1/animations?feed=following')).status, 401);
  assert.equal((await h.request('GET', '/v1/animations?feed=following', { token: fan.token })).data.items.length, 0);
  await h.request('PUT', '/v1/users/lumii55/follow', { token: fan.token });
  assert.equal((await h.request('GET', '/v1/animations?feed=following', { token: fan.token })).data.items.length, 24);
  assert.equal((await h.request('GET', `/v1/animations/${ids[0]}`, { token: fan.token })).data.owner_followed_by_me, true);
});

test('search ignores accents and case, finds tags, descriptions and authors; @ searches authors only', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const maker = await h.signIn('pixelmaker', { name: 'Ana Ribeirão' });
  const publish = async (who, extra) => {
    const id = await uploadAnimation(h, who.token, extra);
    await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
    if (who !== owner) {
      const caseRow = h.db.row("SELECT id FROM cases WHERE target_id = ? AND status = 'open'", id);
      await h.request('POST', `/v1/mod/cases/${caseRow.id}/action`, { token: owner.token, json: { action: 'approve' } });
    }
    return id;
  };
  const yonka = await publish(owner, { title: 'YonKaGor tribute', tags: ['music'] });
  const tagged = await publish(owner, { title: 'Random name', tags: ['yonkagor'] });
  const accented = await publish(owner, { title: 'Animação Ç', extra: { description: 'Feita à mão com Pokémon' } });
  const theirs = await publish(maker, { title: 'Neon wave', tags: ['neon'] });
  const search = async (q) => (await h.request('GET', `/v1/animations?feed=new&q=${encodeURIComponent(q)}`)).data.items.map((item) => item.id).sort();
  assert.deepEqual(await search('yonkagor'), [yonka, tagged].sort());
  assert.deepEqual(await search('YONKA'), [yonka, tagged].sort());
  assert.deepEqual(await search('animacao'), [accented]);
  assert.deepEqual(await search('ANIMAÇÃO ç'), [accented]);
  assert.deepEqual(await search('pokemon'), [accented]);           // description
  assert.deepEqual(await search('ribeirao'), [theirs]);            // author's display name
  assert.deepEqual(await search('pixelmaker'), [theirs]);          // author's handle
  assert.deepEqual(await search('@pixel'), [theirs]);              // authors only
  assert.deepEqual(await search('@neon'), []);                     // "@" does not search titles or tags
  assert.deepEqual(await search('%'), []);

  // Renaming yourself is searchable right away; clearing a profile removes the old name.
  await h.request('PATCH', '/v1/me', { token: maker.token, json: { display_name: 'Estúdio Lua' } });
  assert.deepEqual(await search('estudio'), [theirs]);
  assert.deepEqual(await search('ribeirao'), []);

  // Rows from before the search text existed still match (fallback) and the cron fills them in.
  h.db.sqlite.prepare('UPDATE animations SET search_text = NULL').run();
  h.db.sqlite.prepare('UPDATE users SET search_name = NULL').run();
  assert.deepEqual(await search('yonkagor'), [yonka, tagged].sort());
  assert.deepEqual(await search('@pixelmaker'), [theirs]);
  await h.scheduled();
  assert.equal(h.db.row('SELECT COUNT(*) AS n FROM animations WHERE search_text IS NULL').n, 0);
  assert.equal(h.db.row('SELECT COUNT(*) AS n FROM users WHERE search_name IS NULL').n, 0);
  assert.deepEqual(await search('animacao'), [accented]);
  assert.deepEqual(await search('estudio'), [theirs]);
});

test('downloads count once per viewer per day; the uploader does not count', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const fan = await h.signIn('fan');
  const bytes = fakeZip('dl');
  const id = await uploadAnimation(h, owner.token, { bytes, title: 'Ação Total' });
  await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);

  const anon = await h.request('GET', `/v1/animations/${id}/download`);
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.data, bytes);
  assert.equal(anon.headers.get('Content-Disposition'), 'attachment; filename="Acao-Total-bootanimation.zip"');
  assert.equal(anon.headers.get('X-Content-Sha256'), await sha256Hex(bytes));
  await h.request('GET', `/v1/animations/${id}/download`);
  await h.request('GET', `/v1/animations/${id}/download`, { token: fan.token });
  await h.request('GET', `/v1/animations/${id}/download`, { token: fan.token });
  await h.request('GET', `/v1/animations/${id}/download`, { token: owner.token });
  await h.request('GET', `/v1/animations/${id}/download`, { headers: { 'CF-Connecting-IP': '198.51.100.1' } });
  assert.equal(h.db.row('SELECT downloads FROM animations WHERE id = ?', id).downloads, 3);
  assert.ok(!JSON.stringify(h.db.rows('SELECT * FROM download_marks')).includes('203.0.113.7'));
  h.advance(DAY);
  await h.request('GET', `/v1/animations/${id}/download`, { token: fan.token });
  assert.equal(h.db.row('SELECT downloads FROM animations WHERE id = ?', id).downloads, 4);
});

test('star ratings: one per account, weighted ranking, not on your own work', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const voters = [];
  for (let i = 0; i < 3; i++) voters.push(await h.signIn(`voter${i}`));
  const one = await uploadAnimation(h, owner.token, { title: 'One five-star' });
  const many = await uploadAnimation(h, owner.token, { title: 'Many fours' });
  for (const id of [one, many]) await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);

  assert.equal((await h.request('PUT', `/v1/animations/${one}/rating`, { token: owner.token, json: { stars: 5 } })).data.error.code, 'own_animation');
  assert.equal((await h.request('PUT', `/v1/animations/${one}/rating`, { token: voters[0].token, json: { stars: 6 } })).status, 400);
  const rated = await h.request('PUT', `/v1/animations/${one}/rating`, { token: voters[0].token, json: { stars: 5 } });
  assert.deepEqual(rated.data, { my_rating: 5, rating: { average: 5, count: 1 } });
  for (const voter of voters) await h.request('PUT', `/v1/animations/${many}/rating`, { token: voter.token, json: { stars: 4 } });
  await h.request('PUT', `/v1/animations/${many}/rating`, { token: voters[0].token, json: { stars: 5 } }); // change, not a 4th vote
  const row = h.db.row('SELECT rating_sum, rating_count FROM animations WHERE id = ?', many);
  assert.deepEqual(row, { rating_sum: 13, rating_count: 3 });

  // 3 votes (avg 4.33) rank above a single 5.
  const top = await h.request('GET', '/v1/animations?feed=top');
  assert.deepEqual(top.data.items.map((item) => item.id), [many, one]);
  const removed = await h.request('DELETE', `/v1/animations/${one}/rating`, { token: voters[0].token });
  assert.deepEqual(removed.data.rating, { average: null, count: 0 });
  const detail = await h.request('GET', `/v1/animations/${many}`, { token: voters[0].token });
  assert.equal(detail.data.my_rating, 5);
});

test('remixes credit the original; deleting your animation frees its storage', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const fan = await h.signIn('fan');
  const original = await uploadAnimation(h, owner.token, { title: 'Original' });
  await finishJob(h, sign, lastJob(h, 'animation', original).id, CLEAN);
  const remix = await uploadAnimation(h, fan.token, { title: 'Remix', extra: { remix_of: original } });
  assert.equal(h.db.row('SELECT remix_of FROM animations WHERE id = ?', remix).remix_of, original);
  const bad = await h.request('POST', '/v1/animations', { token: fan.token, json: await draftBody(fakeZip(), { remix_of: 'A'.repeat(16) }) });
  assert.equal(bad.data.error.code, 'invalid_remix');

  const before = Number(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value);
  const size = h.db.row('SELECT size_bytes FROM animations WHERE id = ?', remix).size_bytes;
  assert.equal((await h.request('DELETE', `/v1/animations/${remix}`, { token: owner.token })).status, 404);
  assert.equal((await h.request('DELETE', `/v1/animations/${remix}`, { token: fan.token })).status, 200);
  assert.equal(Number(h.db.row("SELECT value FROM settings WHERE key = 'storage_used_bytes'").value), before - size);
  assert.ok(!h.files.has(`animations/${remix}.zip`));
  assert.equal(h.db.row("SELECT status FROM cases WHERE target_id = ?", remix), null); // never reached review
});

test('preview is served from the pipeline upload and must be WebP', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const id = await uploadAnimation(h, owner.token);
  const job = lastJob(h, 'animation', id);
  const token = await sign();
  const notWebp = await h.request('PUT', `/v1/pipeline/jobs/${job.id}/preview`, { token, raw: new TextEncoder().encode('<svg/>') });
  assert.equal(notWebp.data.error.code, 'invalid_preview');
  const webp = webpBytes(270, 600);
  assert.equal((await h.request('PUT', `/v1/pipeline/jobs/${job.id}/preview`, { token, raw: webp })).status, 200);
  await finishJob(h, sign, job.id, CLEAN);
  const res = await h.request('GET', `/v1/animations/${id}/preview`);
  assert.equal(res.headers.get('Content-Type'), 'image/webp');
  assert.deepEqual(res.data, webp);
  const card = (await h.request('GET', '/v1/animations')).data.items[0];
  assert.equal(card.preview_url, `https://api.test/v1/animations/${id}/preview`);
});

test('scheduled job expires drafts and computes trending', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const hot = await uploadAnimation(h, owner.token, { title: 'Hot' });
  const cold = await uploadAnimation(h, owner.token, { title: 'Cold' });
  for (const id of [hot, cold]) await finishJob(h, sign, lastJob(h, 'animation', id).id, CLEAN);
  for (let i = 0; i < 5; i++) await h.request('GET', `/v1/animations/${hot}/download`, { headers: { 'CF-Connecting-IP': `198.51.100.${i}` } });
  const draft = await h.request('POST', '/v1/animations', { token: owner.token, json: await draftBody(fakeZip('never sent')) });
  h.advance(2 * 3600000);
  await h.scheduled();
  assert.equal(h.db.row('SELECT id FROM animations WHERE id = ?', draft.data.id), null);
  const trending = await h.request('GET', '/v1/animations?feed=trending');
  assert.deepEqual(trending.data.items.map((item) => item.id), [hot, cold]);
});

test('credits: who made the animation (self or someone else) and who made the art', async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const mine = await uploadAnimation(h, owner.token, { title: 'Self made', extra: { credits: { animation_by: 'self', art_by: 'Character art by Example Artist' } } });
  const theirs = await uploadAnimation(h, owner.token, { title: 'Someone else', extra: { credits: { animation_by: 'Pixel Studio' } } });
  for (const id of [mine, theirs]) await finishJob(h, sign, lastJob(h, 'animation', id).id, { ...CLEAN, detected: { manufacturer: 'Motorola' } });
  assert.deepEqual((await h.request('GET', `/v1/animations/${mine}`)).data.credits,
    { animation_by: 'self', art_by: 'Character art by Example Artist', detected_manufacturer: 'Motorola' });
  assert.deepEqual((await h.request('GET', `/v1/animations/${theirs}`)).data.credits, { animation_by: 'Pixel Studio', detected_manufacturer: 'Motorola' });
  const bad = await h.request('POST', '/v1/animations', { token: owner.token, json: await draftBody(fakeZip('x'), { credits: { animation_by: '' } }) });
  assert.equal(bad.data.error.code, 'invalid_length');
  // Editing keeps what the automatic checks detected.
  await h.request('PATCH', `/v1/animations/${mine}`, { token: owner.token, json: { credits: { animation_by: 'self' } } });
  assert.deepEqual((await h.request('GET', `/v1/animations/${mine}`)).data.credits, { animation_by: 'self', detected_manufacturer: 'Motorola' });
});
