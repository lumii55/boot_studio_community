// Boot Animation Studio community API (Cloudflare Worker).

import * as admin from './admin.js';
import * as animations from './animations.js';
import * as auth from './auth.js';
import { LICENSES, LIMITS, REPORT_CATEGORIES } from './config.js';
import { interactions } from './discord.js';
import { corsHeaders, errorResponse, fail, json, withHeaders } from './lib/http.js';
import { Router } from './lib/router.js';
import * as moderation from './moderation.js';
import * as notifications from './notifications.js';
import * as pipeline from './pipeline.js';
import { createReport } from './reports.js';
import { runScheduled } from './scheduled.js';
import { storageStatus } from './storage.js';
import * as users from './users.js';

const API_VERSION = 1;

async function publicConfig(c) {
  const storage = await storageStatus(c.env);
  return json(
    {
      api_version: API_VERSION,
      turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
      uploads_open: !storage.paused,
      limits: {
        animation_bytes: LIMITS.animationBytes,
        avatar_bytes: LIMITS.avatarBytes,
        banner_bytes: LIMITS.bannerBytes,
        title_max: LIMITS.titleMax,
        description_max: LIMITS.descriptionMax,
        tags_max: LIMITS.tagsMax,
        bio_max: LIMITS.bioMax,
        links_max: LIMITS.linksMax,
      },
      licenses: LICENSES,
      featured: (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM animations WHERE status = 'published' AND featured_at IS NOT NULL").first()).n,
      report_categories: Object.keys(REPORT_CATEGORIES),
    },
    200,
    { 'Cache-Control': 'public, max-age=60' },
  );
}

export const router = new Router()
  .on('GET', '/v1/health', () => json({ ok: true, api_version: API_VERSION }))
  .on('GET', '/v1/config', publicConfig)
  // sign-in
  .on('GET', '/v1/auth/github/start', auth.startGithub)
  .on('GET', '/v1/auth/github/callback', auth.githubCallback)
  .on('POST', '/v1/auth/exchange', auth.exchangeGrant)
  .on('POST', '/v1/auth/logout', auth.logout)
  // my account
  .on('GET', '/v1/me', users.me)
  .on('PATCH', '/v1/me', users.updateProfile)
  .on('DELETE', '/v1/me', users.deleteAccount)
  .on('GET', '/v1/me/animations', animations.mine)
  .on('GET', '/v1/me/notifications', notifications.list)
  .on('GET', '/v1/me/notifications/unread', notifications.unread)
  .on('POST', '/v1/me/notifications/read', notifications.markRead)
  .on('PUT', '/v1/me/:kind', users.uploadMedia)
  .on('DELETE', '/v1/me/:kind', users.deleteMedia)
  // profiles
  .on('GET', '/v1/users/:handle', users.getProfile)
  .on('GET', '/v1/users/:handle/animations', users.profileAnimations)
  .on('GET', '/v1/users/:handle/:which', users.followList)
  .on('PUT', '/v1/users/:handle/follow', users.follow)
  .on('DELETE', '/v1/users/:handle/follow', users.follow)
  .on('GET', '/v1/media/:id', users.getMedia)
  // animations
  .on('GET', '/v1/animations', animations.list)
  .on('POST', '/v1/animations', animations.createDraft)
  .on('GET', '/v1/animations/:id', animations.detail)
  .on('PATCH', '/v1/animations/:id', animations.update)
  .on('DELETE', '/v1/animations/:id', animations.remove)
  .on('PUT', '/v1/animations/:id/file', animations.uploadFile)
  .on('GET', '/v1/animations/:id/download', animations.download)
  .on('GET', '/v1/animations/:id/preview', animations.preview)
  .on('GET', '/v1/animations/:id/remixes', animations.remixes)
  .on('PUT', '/v1/animations/:id/rating', animations.rate)
  .on('DELETE', '/v1/animations/:id/rating', animations.rate)
  // reports and moderation
  .on('POST', '/v1/reports', createReport)
  .on('GET', '/v1/mod/summary', moderation.summary)
  .on('GET', '/v1/mod/queue', moderation.queue)
  .on('GET', '/v1/mod/audit', moderation.audit)
  .on('GET', '/v1/mod/cases/:id', moderation.caseDetail)
  .on('POST', '/v1/mod/cases/:id/action', moderation.caseAction)
  .on('GET', '/v1/mod/team', moderation.team)
  .on('GET', '/v1/mod/stats', admin.stats)
  .on('PUT', '/v1/mod/settings/uploads', admin.setUploadsPaused)
  .on('GET', '/v1/mod/users', admin.listUsers)
  .on('POST', '/v1/mod/users/:handle/action', admin.userAction)
  .on('GET', '/v1/mod/animations', admin.listAnimations)
  .on('POST', '/v1/mod/animations/:id/action', admin.animationAction)
  .on('PUT', '/v1/mod/users/:handle/role', moderation.setRole)
  .on('PUT', '/v1/mod/users/:handle/discord', moderation.setDiscord)
  // automatic checks (GitHub Actions, OIDC) and the Discord bot
  .on('GET', '/v1/pipeline/jobs/:id', pipeline.getJob)
  .on('GET', '/v1/pipeline/jobs/:id/file', pipeline.getJobFile)
  .on('PUT', '/v1/pipeline/jobs/:id/preview', pipeline.putJobPreview)
  .on('POST', '/v1/pipeline/jobs/:id/result', pipeline.postJobResult)
  .on('POST', '/v1/discord/interactions', interactions);

export function makeContext(request, env, ctx, now = Date.now()) {
  return {
    request,
    env,
    url: new URL(request.url),
    params: {},
    now,
    user: null,
    userLoaded: false,
    waitUntil: (promise) => (ctx && ctx.waitUntil ? ctx.waitUntil(promise) : promise),
  };
}

export async function handle(request, env, ctx, now = Date.now()) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const c = makeContext(request, env, ctx, now);
  let response;
  try {
    const found = router.match(request.method, c.url.pathname);
    if (!found.handler) throw fail(found.status, found.status === 405 ? 'method_not_allowed' : 'not_found', 'Not found');
    c.params = found.params;
    response = await found.handler(c);
  } catch (err) {
    response = errorResponse(err);
  }
  return withHeaders(response, cors);
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: (event, env, ctx) => {
    const c = makeContext(new Request('https://scheduled.invalid/'), env, ctx, event.scheduledTime || Date.now());
    ctx.waitUntil(runScheduled(c));
  },
};
