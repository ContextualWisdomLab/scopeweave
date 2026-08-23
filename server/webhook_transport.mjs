import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const DENIED_IPV4_BLOCKS = new BlockList();
const DENIED_IPV6_BLOCKS = new BlockList();
const PUBLIC_IPV6_UNICAST = new BlockList();
PUBLIC_IPV6_UNICAST.addSubnet('2000::', 3, 'ipv6');

for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.31.196.0', 24, 'ipv4'],
  ['192.52.193.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['192.175.48.0', 24, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['100:0:0:1::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['2620:4f:8000::', 48, 'ipv6'],
  ['3ffe::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'],
  ['5f00::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]) {
  (family === 'ipv4' ? DENIED_IPV4_BLOCKS : DENIED_IPV6_BLOCKS)
    .addSubnet(address, prefix, family);
}

const SAFE_ERROR = 'webhook destination unavailable';
const POLICY_ERROR = 'webhook destination is not permitted';

/** Stable, non-secret webhook destination policy failure. */
export class WebhookDestinationError extends Error {
  constructor() {
    super(POLICY_ERROR);
    this.name = 'WebhookDestinationError';
  }
}

/** Stable, non-secret resolver/TLS/transport failure. */
export class WebhookTransportError extends Error {
  constructor() {
    super(SAFE_ERROR);
    this.name = 'WebhookTransportError';
  }
}

function hostAddress(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === 'home.arpa'
    || host.endsWith('.home.arpa');
}

/**
 * Return whether an address is an ordinary Internet-routable webhook target.
 * IPv4 special-purpose ranges are denied. IPv6 must be within the ordinary
 * 2000::/3 global-unicast envelope and outside denied special-use blocks.
 */
export function isPublicWebhookAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 4) return !DENIED_IPV4_BLOCKS.check(address, 'ipv4');
  return PUBLIC_IPV6_UNICAST.check(address, 'ipv6')
    && !DENIED_IPV6_BLOCKS.check(address, 'ipv6');
}

/**
 * Parse and canonicalize a production webhook URL without performing DNS.
 * DNS authorization is repeated immediately before each network attempt.
 */
export function validateWebhookRegistrationUrl(value) {
  let destination;
  try {
    destination = new URL(String(value ?? ''));
  } catch {
    throw new WebhookDestinationError();
  }
  if (destination.protocol !== 'https:'
      || destination.username
      || destination.password
      || destination.hash
      || !destination.hostname
      || isLocalHostname(destination.hostname)) {
    throw new WebhookDestinationError();
  }
  const literal = hostAddress(destination.hostname);
  if (isIP(literal) && !isPublicWebhookAddress(literal)) {
    throw new WebhookDestinationError();
  }
  return destination.href;
}

async function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw new WebhookTransportError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new WebhookTransportError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function resolvePublicAddresses(destination, lookup, signal) {
  const literal = hostAddress(destination.hostname);
  if (isIP(literal)) {
    if (!isPublicWebhookAddress(literal)) throw new WebhookDestinationError();
    return [{ address: literal, family: isIP(literal) }];
  }

  let answers;
  try {
    answers = await withAbort(
      Promise.resolve(lookup(destination.hostname, { all: true, verbatim: true })),
      signal,
    );
  } catch (error) {
    if (error instanceof WebhookDestinationError || error instanceof WebhookTransportError) throw error;
    throw new WebhookTransportError();
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new WebhookTransportError();

  const normalized = [];
  const seen = new Set();
  for (const answer of answers) {
    const address = String(answer?.address || '');
    const actualFamily = isIP(address);
    const family = Number(answer?.family) || actualFamily;
    if ((family !== 4 && family !== 6)
        || actualFamily !== family
        || !isPublicWebhookAddress(address)) {
      throw new WebhookDestinationError();
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ address, family });
    }
  }
  if (!normalized.length) throw new WebhookTransportError();
  return normalized;
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function requestOptions(destination, candidate, headers, signal) {
  const tlsHost = hostAddress(destination.hostname);
  return {
    method: 'POST',
    headers,
    signal,
    agent: false,
    lookup: pinnedLookup(candidate.address, candidate.family),
    ...(isIP(tlsHost) ? {} : { servername: tlsHost }),
  };
}

function trackSecureConnect(request, attempt) {
  request.once?.('socket', (socket) => {
    socket?.once?.('secureConnect', () => {
      attempt.secureConnected = true;
    });
  });
}

async function postToCandidate(destination, candidate, { headers, body, signal, attempt }, request) {
  if (signal?.aborted) throw new WebhookTransportError();
  try {
    return await withAbort(new Promise((resolve, reject) => {
      let req;
      try {
        req = request(
          destination,
          requestOptions(destination, candidate, headers, signal),
          (response) => {
            response.resume?.();
            const status = Number(response.statusCode) || 0;
            resolve({ status, ok: status >= 200 && status < 300 });
          },
        );
      } catch {
        reject(new WebhookTransportError());
        return;
      }
      trackSecureConnect(req, attempt);
      req.once?.('error', () => reject(new WebhookTransportError()));
      req.end(body);
    }), signal);
  } catch (error) {
    if (error instanceof WebhookTransportError) throw error;
    throw new WebhookTransportError();
  }
}

/**
 * Build the outbound webhook transport around injectable DNS and HTTPS seams.
 * Every POST resolves afresh, rejects mixed/private answers, pins the socket to
 * a validated candidate, preserves Host/TLS authority, disables pooling, and
 * never follows redirects. A pre-handshake connect failure may fall through to
 * another already-validated candidate; after TLS succeeds delivery is ambiguous
 * and the signed body is never replayed within the same attempt.
 */
export function createWebhookTransport({ lookup = dnsLookup, request = httpsRequest } = {}) {
  if (typeof lookup !== 'function' || typeof request !== 'function') {
    throw new TypeError('webhook transport dependencies must be functions');
  }

  return Object.freeze({
    async post(url, { headers = {}, body = '', signal } = {}) {
      let destination;
      try {
        destination = new URL(validateWebhookRegistrationUrl(url));
      } catch (error) {
        if (error instanceof WebhookDestinationError) throw error;
        throw new WebhookDestinationError();
      }

      const candidates = await resolvePublicAddresses(destination, lookup, signal);
      const requestHeaders = Object.fromEntries(new Headers(headers).entries());
      delete requestHeaders['content-length'];
      let lastError;
      for (const candidate of candidates) {
        const attempt = { secureConnected: false };
        try {
          return await postToCandidate(
            destination,
            candidate,
            { headers: requestHeaders, body, signal, attempt },
            request,
          );
        } catch (error) {
          if (!(error instanceof WebhookTransportError)) throw error;
          lastError = error;
          if (signal?.aborted || attempt.secureConnected) throw error;
        }
      }
      throw lastError || new WebhookTransportError();
    },
  });
}

const webhookTransport = createWebhookTransport();

/** Send one signed webhook attempt through the production SSRF-safe transport. */
export const postWebhook = (url, options) => webhookTransport.post(url, options);
