// JSON shapes returned to the site. Keep them small: they are what the feed renders.

import { isModerator } from './auth.js';

export const mediaUrl = (env, id) => (id ? new URL(`/v1/media/${id}`, env.PUBLIC_URL).href : null);

export function userCard(env, row, prefix = '') {
  const get = (name) => row[prefix + name];
  return {
    handle: get('handle'),
    display_name: get('display_name') || get('handle'),
    avatar_url: mediaUrl(env, get('avatar_media_id')) || get('github_avatar_url') || null,
  };
}

export function publicProfile(env, user, viewer, extra = {}) {
  return {
    ...userCard(env, user),
    bio: user.bio,
    links: JSON.parse(user.links || '[]'),
    banner_url: mediaUrl(env, user.banner_media_id),
    github_url: `https://github.com/${user.handle}`,
    role: user.role === 'user' ? null : user.role,
    followers: user.followers_count,
    following: user.following_count,
    joined_at: user.created_at,
    is_me: !!viewer && viewer.id === user.id,
    ...extra,
  };
}

export function ownProfile(env, user, pending) {
  return {
    ...publicProfile(env, user, user),
    role: user.role,
    trust: user.trust,
    discord_linked: !!user.discord_id,
    pending_avatar_url: pending.avatar ? mediaUrl(env, pending.avatar) : null,
    pending_banner_url: pending.banner ? mediaUrl(env, pending.banner) : null,
  };
}

export function ratingOf(row) {
  return {
    average: row.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : null,
    count: row.rating_count,
  };
}

// `row` comes from a query joining the owner columns with the "o_" prefix.
export function animationCard(env, row) {
  return {
    id: row.id,
    title: row.title,
    owner: userCard(env, row, 'o_'),
    preview_url: row.has_preview ? new URL(`/v1/animations/${row.id}/preview`, env.PUBLIC_URL).href : null,
    width: row.width,
    height: row.height,
    fps: row.fps,
    size_bytes: row.size_bytes,
    downloads: row.downloads,
    rating: ratingOf(row),
    tags: JSON.parse(row.tags || '[]'),
    published_at: row.published_at,
    featured: !!row.featured_at,
  };
}

export function animationDetail(env, row, viewer, extra = {}) {
  const mine = !!viewer && viewer.id === row.owner_id;
  const detail = {
    ...animationCard(env, row),
    description: row.description,
    license: row.license,
    credits: JSON.parse(row.credits || '{}'),
    remix_of: row.remix_of,
    frame_count: row.frame_count,
    parts: row.parts,
    has_audio: !!row.has_audio,
    sha256: row.sha256,
    download_url: new URL(`/v1/animations/${row.id}/download`, env.PUBLIC_URL).href,
    is_mine: mine,
    ...extra,
  };
  if (mine || isModerator(viewer)) {
    detail.status = row.status;
    detail.status_reason = row.status_reason;
  }
  return detail;
}

export const OWNER_COLUMNS =
  'o.handle AS o_handle, o.display_name AS o_display_name, o.avatar_media_id AS o_avatar_media_id, o.github_avatar_url AS o_github_avatar_url';
