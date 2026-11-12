// Per-moderator permissions. The owner can do everything; a moderator only what was ticked for them
// (all off by default). Every moderator can see the panel and write internal notes.

import { fail } from './lib/http.js';

export const PERMISSIONS = [
  'review',        // decide cases: approve / hide; hide or restore animations
  'remove',        // remove content for good
  'feature',       // feature animations in Explore
  'recheck',       // run the automatic checks again (one or all)
  'trust',         // mark people as trusted / not trusted
  'clear_profile', // clear a person's name, bio, links and images
  'warn',          // give warnings
  'restrict',      // restrict uploads / reports / ratings / profile edits
  'suspend',       // temporary suspensions
  'ban',           // permanent bans
  'announce',      // the Community announcement
  'export',        // export a person's data (LGPD requests)
];

export function permissionsOf(user) {
  if (!user) return [];
  if (user.role === 'owner') return PERMISSIONS.slice();
  if (user.role !== 'moderator') return [];
  try {
    const list = JSON.parse(user.permissions || '[]');
    return Array.isArray(list) ? list.filter((item) => PERMISSIONS.includes(item)) : [];
  } catch {
    return [];
  }
}

export const can = (user, permission) => permissionsOf(user).includes(permission);

export function requirePermission(user, permission) {
  if (!can(user, permission)) {
    throw fail(403, 'no_permission', 'You do not have permission for this', { details: { permission } });
  }
}

export function cleanPermissions(value) {
  if (!Array.isArray(value)) throw fail(400, 'invalid_field', 'permissions must be a list');
  return PERMISSIONS.filter((permission) => value.includes(permission));
}

export const CASE_ACTION_PERMISSION = { approve: 'review', hide: 'review', remove: 'remove', ban: 'ban', clear_profile: 'clear_profile' };
export const ANIMATION_ACTION_PERMISSION = {
  hide: 'review', restore: 'review', remove: 'remove', recheck: 'recheck', feature: 'feature', unfeature: 'feature',
};
export const SANCTION_PERMISSION = { warning: 'warn', restrict: 'restrict', suspend: 'suspend', ban: 'ban' };
