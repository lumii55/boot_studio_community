// Verifies GitHub Actions OIDC tokens, so the moderation workflow can talk to the Worker without
// any shared secret. Only the moderation workflow on main of the community repo is accepted.

import { b64urlDecode } from './util.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = { at: 0, keys: [] };

export function resetJwksCache() {
  jwksCache = { at: 0, keys: [] };
}

async function signingKeys(now, forceRefresh) {
  if (!forceRefresh && jwksCache.keys.length && now - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error('jwks unavailable');
  const body = await response.json();
  jwksCache = { at: now, keys: Array.isArray(body.keys) ? body.keys : [] };
  return jwksCache.keys;
}

function decodePart(part) {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
}

// Returns the verified claims or null.
export async function verifyActionsToken(token, { audience, repository, workflow, now }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  let keys = await signingKeys(now, false);
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    keys = await signingKeys(now, true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA') return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expectedWorkflow = `${repository}/.github/workflows/${workflow}@refs/heads/main`;
  if (claims.iss !== ISSUER) return null;
  if (!audiences.includes(audience)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < seconds - 30) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > seconds + 30) return null;
  if (claims.repository !== repository) return null;
  if (claims.ref !== 'refs/heads/main') return null;
  if (claims.event_name !== 'workflow_dispatch') return null;
  if (claims.job_workflow_ref !== expectedWorkflow) return null;
  return claims;
}
