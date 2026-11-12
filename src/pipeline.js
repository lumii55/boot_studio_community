// Automatic checks. The Worker only queues a job and starts the `moderation.yml` workflow of the community
// repository; the workflow does the heavy work (ZIP rules, frames, preview, classifiers) and reports back.
// The workflow proves who it is with a GitHub Actions OIDC token: no shared secret exists.

import { PIPELINE_AUDIENCE, PIPELINE_MAX_ATTEMPTS, PIPELINE_STALE_MS, PIPELINE_WORKFLOW } from './config.js';
import { fail, json, readBytes, readJson } from './lib/http.js';
import { sniffImage } from './lib/images.js';
import { verifyActionsToken } from './lib/oidc.js';
import { newId, requireId } from './lib/util.js';
import { applyAnimationVerdict, applyMediaVerdict, applyProfileVerdict } from './moderation.js';
import { getSettings } from './settings.js';
import { animationKey, mediaKey, previewKey } from './storage.js';

export async function queueJob(c, kind, subjectId) {
  const id = newId();
  await c.env.DB.prepare(
    "INSERT INTO pipeline_jobs (id, kind, subject_id, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
  )
    .bind(id, kind, subjectId, c.now, c.now)
    .run();
  c.waitUntil(dispatchJob(c.env, id, c.now));
  return id;
}

export async function dispatchJob(env, jobId, now) {
  if (!env.GH_DISPATCH_TOKEN || !env.MODERATION_REPO) {
    console.warn('pipeline dispatch not configured; job stays queued', jobId);
    return false;
  }
  let ok = false;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${env.MODERATION_REPO}/actions/workflows/${PIPELINE_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'bas-community',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main', inputs: { job_id: jobId } }),
      },
    );
    ok = response.status === 204;
    if (!ok) console.error('pipeline dispatch failed', response.status);
  } catch (err) {
    console.error('pipeline dispatch error', err && err.message);
  }
  await env.DB.prepare(
    `UPDATE pipeline_jobs SET status = CASE WHEN ? THEN 'dispatched' ELSE status END,
       attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'dispatched')`,
  )
    .bind(ok ? 1 : 0, now, jobId)
    .run();
  return ok;
}

// "Re-check everything" queues jobs without starting them; the cron starts a few per run (GitHub runs them in turn).
export async function dispatchQueued(c, limit = 10) {
  const rows = await c.env.DB.prepare("SELECT id FROM pipeline_jobs WHERE status = 'queued' AND attempts = 0 ORDER BY created_at LIMIT ?")
    .bind(limit).all();
  for (const row of rows.results) await dispatchJob(c.env, row.id, c.now);
  return rows.results.length;
}

// Called by the scheduled handler: retry jobs that never started or got stuck; give up after a few tries.
export async function retryStaleJobs(c) {
  const stale = await c.env.DB.prepare(
    `SELECT id, kind, subject_id, attempts FROM pipeline_jobs
     WHERE status IN ('queued', 'dispatched', 'running') AND updated_at < ? ORDER BY updated_at LIMIT 20`,
  )
    .bind(c.now - PIPELINE_STALE_MS)
    .all();
  for (const job of stale.results) {
    if (job.attempts >= PIPELINE_MAX_ATTEMPTS) {
      await c.env.DB.prepare("UPDATE pipeline_jobs SET status = 'failed', updated_at = ? WHERE id = ?").bind(c.now, job.id).run();
      await verdictFor(c, job, {
        verdict: 'review',
        findings: [{ code: 'pipeline_failed', severity: 1, message: 'Automatic checks did not finish; review manually.' }],
      });
    } else {
      await c.env.DB.prepare("UPDATE pipeline_jobs SET status = 'queued' WHERE id = ?").bind(job.id).run();
      await dispatchJob(c.env, job.id, c.now);
    }
  }
}

async function requirePipeline(c) {
  const header = c.request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const claims = token
    ? await verifyActionsToken(token, {
        audience: PIPELINE_AUDIENCE,
        repository: c.env.MODERATION_REPO,
        workflow: PIPELINE_WORKFLOW,
        now: c.now,
      })
    : null;
  if (!claims) throw fail(401, 'pipeline_auth', 'Not the moderation workflow');
  const id = requireId(c.params.id, 'job');
  const job = await c.env.DB.prepare('SELECT * FROM pipeline_jobs WHERE id = ?').bind(id).first();
  if (!job) throw fail(404, 'not_found', 'Unknown job');
  return job;
}

export async function getJob(c) {
  const job = await requirePipeline(c);
  if (job.status === 'done' || job.status === 'failed') throw fail(409, 'job_finished', 'Job already finished');
  await c.env.DB.prepare("UPDATE pipeline_jobs SET status = 'running', updated_at = ? WHERE id = ?").bind(c.now, job.id).run();
  const fileUrl = new URL(`/v1/pipeline/jobs/${job.id}/file`, c.env.PUBLIC_URL).href;
  let subject;
  if (job.kind === 'animation') {
    const row = await c.env.DB.prepare(
      'SELECT id, title, description, tags, credits, sha256, size_bytes, status FROM animations WHERE id = ?',
    ).bind(job.subject_id).first();
    if (!row) throw fail(404, 'subject_gone', 'The animation no longer exists');
    subject = { ...row, tags: JSON.parse(row.tags), credits: JSON.parse(row.credits), file_url: fileUrl };
  } else if (job.kind === 'media') {
    const row = await c.env.DB.prepare('SELECT id, kind, content_type, size_bytes FROM media WHERE id = ?').bind(job.subject_id).first();
    if (!row) throw fail(404, 'subject_gone', 'The image no longer exists');
    subject = { ...row, file_url: fileUrl };
  } else {
    const row = await c.env.DB.prepare('SELECT id, handle, display_name, bio, links FROM users WHERE id = ?').bind(job.subject_id).first();
    if (!row) throw fail(404, 'subject_gone', 'The user no longer exists');
    subject = { ...row, links: JSON.parse(row.links) };
  }
  const { detector } = await getSettings(c.env);
  return json({ job: { id: job.id, kind: job.kind }, subject, sensitivity: detector });
}

export async function getJobFile(c) {
  const job = await requirePipeline(c);
  const key = job.kind === 'animation' ? animationKey(job.subject_id) : job.kind === 'media' ? mediaKey(job.subject_id) : null;
  const object = key ? await c.env.FILES.get(key) : null;
  if (!object) throw fail(404, 'not_found', 'No file for this job');
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), 'Cache-Control': 'no-store' },
  });
}

export async function putJobPreview(c) {
  const job = await requirePipeline(c);
  if (job.kind !== 'animation') throw fail(400, 'invalid_job', 'Only animation jobs have previews');
  const bytes = await readBytes(c.request, 2 * 1024 * 1024);
  const image = sniffImage(bytes);
  if (!image || image.type !== 'image/webp') throw fail(400, 'invalid_preview', 'Preview must be WebP');
  await c.env.FILES.put(previewKey(job.subject_id), bytes, { httpMetadata: { contentType: 'image/webp' } });
  await c.env.DB.prepare('UPDATE animations SET has_preview = 1, updated_at = ? WHERE id = ?').bind(c.now, job.subject_id).run();
  return json({ ok: true });
}

const VERDICTS = new Set(['clean', 'review', 'reject']);

function cleanFindings(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((item) => ({
    code: String(item && item.code || 'unknown').slice(0, 64),
    severity: Math.max(0, Math.min(3, Number(item && item.severity) || 0)),
    message: String(item && item.message || '').slice(0, 300),
  }));
}

export async function postJobResult(c) {
  const job = await requirePipeline(c);
  if (job.status === 'done' || job.status === 'failed') throw fail(409, 'job_finished', 'Job already finished');
  const body = await readJson(c.request, 64 * 1024);
  if (!VERDICTS.has(body.verdict)) throw fail(400, 'invalid_verdict', 'Unknown verdict');
  const result = {
    verdict: body.verdict,
    findings: cleanFindings(body.findings),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
    detected: body.detected && typeof body.detected === 'object' ? body.detected : {},
  };
  const marked = await c.env.DB.prepare(
    "UPDATE pipeline_jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'failed') RETURNING id",
  )
    .bind(JSON.stringify(result).slice(0, 60000), c.now, job.id)
    .first();
  if (!marked) throw fail(409, 'job_finished', 'Job already finished');
  await verdictFor(c, job, result);
  return json({ ok: true });
}

async function verdictFor(c, job, result) {
  if (job.kind === 'animation') return applyAnimationVerdict(c, job.subject_id, result);
  if (job.kind === 'media') return applyMediaVerdict(c, job.subject_id, result);
  return applyProfileVerdict(c, job.subject_id, result);
}

