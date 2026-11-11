// End to end: the real Worker (behind a local HTTP server) and the real pipeline script (Python), the way
// GitHub Actions runs it. Needs Python with Pillow ($PYTHON, default python3); skipped otherwise.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/index.js';
import { createHarness, lastJob, oidcSigner, OWNER_GITHUB_ID, uploadAnimation } from './helpers.js';

const PYTHON = process.env.PYTHON || 'python3';
const PIPELINE = fileURLToPath(new URL('../pipeline/', import.meta.url));

function pillowAvailable() {
  try {
    execFileSync(PYTHON, ['-c', 'import PIL'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeZip(script) {
  return new Uint8Array(execFileSync(PYTHON, ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(PIPELINE)})
from test_checks import build_zip, good_entries, frame
${script}
sys.stdout.buffer.write(data)
`]));
}

async function serve(h, sign) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url.startsWith('/oidc')) {
      const audience = new URL(req.url, 'http://x').searchParams.get('audience');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: await sign({ aud: audience }) }));
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    const request = new Request(`https://api.test${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await handle(request, h.env, { waitUntil: (p) => h.pending.push(p) }, h.now);
    await h.settle();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function runJob(port, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', `${PIPELINE}run_job.py`], {
      env: {
        PATH: process.env.PATH,
        JOB_ID: jobId,
        BAS_API: `http://127.0.0.1:${port}`,
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?x=1`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-token',
        BAS_VISION: 'off', // the image model has its own tests (pipeline/test_vision.py)
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

test('pipeline script: a valid animation gets a preview and goes to review (no image classifier yet)', { skip: !pillowAvailable() && 'Pillow not available' }, async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const server = await serve(h, sign);
  try {
    const bytes = makeZip('data = build_zip(good_entries(frames=20))');
    const id = await uploadAnimation(h, owner.token, { bytes, title: 'Real zip' });
    const result = await runJob(server.address().port, lastJob(h, 'animation', id).id);
    assert.equal(result.verdict, 'review');
    assert.deepEqual(result.codes, ['visual_check_pending']);
    const row = h.db.row('SELECT status, width, height, fps, frame_count, parts, has_preview FROM animations WHERE id = ?', id);
    assert.deepEqual(row, { status: 'review', width: 108, height: 240, fps: 30, frame_count: 40, parts: 2, has_preview: 1 });
    assert.equal(h.files.objects.get(`previews/${id}.webp`).bytes.slice(8, 12).toString(), [0x57, 0x45, 0x42, 0x50].toString());
  } finally {
    server.close();
  }
});

test('pipeline script: a ZIP with a script inside is rejected and deleted', { skip: !pillowAvailable() && 'Pillow not available' }, async () => {
  const h = createHarness();
  const sign = await oidcSigner(h);
  const owner = await h.signIn('lumii55', { id: OWNER_GITHUB_ID });
  const server = await serve(h, sign);
  try {
    const bytes = makeZip('data = build_zip(good_entries() + [("service.sh", b"rm -rf /")])');
    const id = await uploadAnimation(h, owner.token, { bytes, title: 'Evil zip' });
    const result = await runJob(server.address().port, lastJob(h, 'animation', id).id);
    assert.equal(result.verdict, 'reject');
    assert.equal(h.db.row('SELECT status FROM animations WHERE id = ?', id).status, 'rejected');
    assert.ok(!h.files.has(`animations/${id}.zip`));
  } finally {
    server.close();
  }
});
