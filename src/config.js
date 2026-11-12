// Limits and policy in one place. Values that depend on the deployment (URLs, IDs) come from `env`.

export const MB = 1024 * 1024;

export const LIMITS = {
  animationBytes: 50 * MB,
  avatarBytes: 512 * 1024,
  bannerBytes: 2 * MB,
  avatarMaxSide: 1024,
  bannerMaxWidth: 3000,
  bannerMaxHeight: 1200,
  jsonBodyBytes: 16 * 1024,
  titleMin: 3,
  titleMax: 60,
  descriptionMax: 1000,
  tagsMax: 8,
  tagMax: 24,
  displayNameMax: 40,
  bioMax: 300,
  linksMax: 4,
  linkMax: 200,
  reportNoteMax: 500,
  reasonMax: 500,
  pageSize: 24,
  pageSizeMax: 48,
};

// Default global storage guard: pause uploads before the R2 free tier (10 GB) is exceeded.
export const DEFAULT_STORAGE_LIMIT_BYTES = 9.5 * 1024 * MB;

// Anti-spam windows: [max, seconds].
export const RATE = {
  uploadHour: [5, 3600],
  uploadDay: [20, 86400],
  mediaHour: [10, 3600],
  profileHour: [20, 3600],
  reportDay: [20, 86400],
  ratingHour: [120, 3600],
  followHour: [120, 3600],
  authMinute: [20, 60],
};

export const SESSION_DAYS = 30;
export const OAUTH_STATE_MINUTES = 10;
export const GRANT_SECONDS = 120;
export const DRAFT_TTL_MS = 60 * 60 * 1000;

// A GitHub account younger than this always goes through manual review.
export const NEW_ACCOUNT_DAYS = 30;

// Reports. Severity 3 = critical: even a single report is surfaced at the top and re-scanned.
export const REPORT_CATEGORIES = {
  criminal: 3,
  nudity: 3,
  gore: 2,
  violence: 2,
  hate: 2,
  uncredited: 1,
  spam: 1,
  other: 1,
};
// Distinct reporters needed for the "mass reported" tab (the item is hidden until reviewed).
export const MASS_REPORT_THRESHOLD = 3;

// Weighted rating: (PRIOR_WEIGHT * PRIOR_MEAN + sum) / (PRIOR_WEIGHT + count).
export const RATING_PRIOR_MEAN = 3;
export const RATING_PRIOR_WEIGHT = 5;

// License id → may others publish modified versions (remixes)? A custom license says it itself (null here).
// Must match site/community/licenses.js (a test checks it).
export const LICENSE_REMIX = Object.freeze({
  'cc-by-4.0': true, 'cc-by-sa-4.0': true, 'cc-by-nc-4.0': true, 'cc-by-nc-sa-4.0': true,
  'cc-by-nd-4.0': false, 'cc-by-nc-nd-4.0': false, 'cc0-1.0': true,
  mit: true, 'apache-2.0': true, 'gpl-3.0': true, 'gpl-2.0': true, 'agpl-3.0': true, 'lgpl-3.0': true, 'lgpl-2.1': true,
  'mpl-2.0': true, 'epl-2.0': true, 'bsd-2-clause': true, 'bsd-3-clause': true, 'bsl-1.0': true, unlicense: true,
  'all-rights-reserved': false, custom: null,
});
export const LICENSES = Object.keys(LICENSE_REMIX);
export const CUSTOM_LICENSE = { nameMax: 60, urlMax: 300 };

export const PIPELINE_AUDIENCE = 'bas-community';
export const PIPELINE_WORKFLOW = 'moderation.yml';
export const PIPELINE_STALE_MS = 30 * 60 * 1000;
export const PIPELINE_MAX_ATTEMPTS = 3;
