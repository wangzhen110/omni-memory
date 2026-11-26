// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * One HTTP trust boundary for both the plugin half (`index.js`) and the
 * standalone daemon (`hosts/http/server.mjs`).
 *
 * A loopback socket alone is not authentication: a DNS-rebinding page also
 * reaches 127.0.0.1. The Host header is the field that page cannot choose, so
 * every local request must name a loopback host, the configured bind address,
 * or an operator-supplied `OMNI_TRUSTED_HOSTS` entry.
 */

export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Host names this process is willing to answer for. */
export function trustedHostNames() {
  const names = new Set(['127.0.0.1', 'localhost', '::1']);
  const add = raw => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value || value === '0.0.0.0' || value === '::' || value === '*') return;
    const hostname = value.startsWith('[')
      ? value.slice(1, value.indexOf(']'))
      : value.split(':')[0];
    if (hostname) names.add(hostname);
  };
  for (const item of String(process.env.OMNI_TRUSTED_HOSTS ?? '').split(',')) add(item);
  add(process.env.OMNI_HTTP_BIND);
  return names;
}

export function requestHostName(req) {
  const raw = String(req?.headers?.host ?? '').trim().toLowerCase();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function hostHeaderAllowed(req) {
  const name = requestHostName(req);
  return Boolean(name && trustedHostNames().has(name));
}

/**
 * Request-forgery guard for mutating routes.
 *
 * A browser sends Origin on cross-site POSTs; a local non-browser client may
 * omit it. An Origin is accepted only when its host is both the request Host
 * and a trusted local host name. The old check compared Origin with Host alone,
 * which let `Host: attacker.example` authenticate `Origin: attacker.example`
 * after DNS rebinding. The explicit CSRF header remains necessary because a
 * malicious page cannot send it without a CORS preflight this server never
 * grants.
 */
export function sameOrigin(req) {
  if (String(req?.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase() === 'cross-site') return false;
  const origin = String(req?.headers?.origin ?? '').trim();
  if (!origin) return true;
  if (!hostHeaderAllowed(req)) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const requestHost = String(req?.headers?.host ?? '').trim().toLowerCase();
  return parsed.host.toLowerCase() === requestHost;
}

export function mutationAllowed(req) {
  if (!sameOrigin(req)) return false;
  return String(req?.headers?.['x-omni-csrf'] ?? '') === '1';
}
