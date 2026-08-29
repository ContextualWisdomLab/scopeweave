import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const DENIED_IPV4_BLOCKS = new BlockList();
const DENIED_IPV6_BLOCKS = new BlockList();
const PUBLIC_IPV6_UNICAST = new BlockList();
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

PUBLIC_IPV6_UNICAST.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.31.196.0', 24, 'ipv4'],
  ['192.52.193.0', 24, 'ipv4'], ['192.88.99.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['192.175.48.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'],
  ['100:0:0:1::', 64, 'ipv6'], ['2001::', 23, 'ipv6'], ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'], ['2620:4f:8000::', 48, 'ipv6'], ['3ffe::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'], ['5f00::', 16, 'ipv6'], ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]) {
  (family === 'ipv4' ? DENIED_IPV4_BLOCKS : DENIED_IPV6_BLOCKS).addSubnet(address, prefix, family);
}

const SAFE_ERROR = 'public HTTPS destination unavailable';
const POLICY_ERROR = 'public HTTPS destination is not permitted';

/** A stable, non-secret outbound destination policy failure. */
export class PublicHttpsDestinationError extends Error {
  constructor() {
    super(POLICY_ERROR);
    this.name = 'PublicHttpsDestinationError';
  }
}

/** A stable, non-secret DNS/TLS/transport failure. */
export class PublicHttpsTransportError extends Error {
  constructor() {
    super(SAFE_ERROR);
    this.name = 'PublicHttpsTransportError';
  }
}

function hostAddress(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === 'home.arpa'
    || host.endsWith('.home.arpa');
}

/** Return true only for ordinary public Internet IP addresses. */
export function isPublicInternetAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 4) return !DENIED_IPV4_BLOCKS.check(address, 'ipv4');
  return PUBLIC_IPV6_UNICAST.check(address, 'ipv6') && !DENIED_IPV6_BLOCKS.check(address, 'ipv6');
}

/** Parse and canonicalize an HTTPS URL, rejecting local and private literal targets. */
export function validatePublicHttpsUrl(value) {
  let destination;
  try {
    destination = new URL(String(value ?? ''));
  } catch {
    throw new PublicHttpsDestinationError();
  }
  if (destination.protocol !== 'https:'
      || destination.username
      || destination.password
      || destination.hash
      || !destination.hostname
      || isLocalHostname(destination.hostname)) {
    throw new PublicHttpsDestinationError();
  }
  const literal = hostAddress(destination.hostname);
  if (isIP(literal) && !isPublicInternetAddress(literal)) throw new PublicHttpsDestinationError();
  return destination.href;
}

async function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw new PublicHttpsTransportError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new PublicHttpsTransportError());
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
    if (!isPublicInternetAddress(literal)) throw new PublicHttpsDestinationError();
    return [{ address: literal, family: isIP(literal) }];
  }

  let answers;
  try {
    answers = await withAbort(Promise.resolve(lookup(destination.hostname, { all: true, verbatim: true })), signal);
  } catch (error) {
    if (error instanceof PublicHttpsDestinationError || error instanceof PublicHttpsTransportError) throw error;
    throw new PublicHttpsTransportError();
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new PublicHttpsTransportError();

  const normalized = [];
  const seen = new Set();
  for (const answer of answers) {
    const address = String(answer?.address || '');
    const family = Number(answer?.family) || isIP(address);
    if ((family !== 4 && family !== 6) || !isPublicInternetAddress(address)) {
      throw new PublicHttpsDestinationError();
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ address, family });
    }
  }
  if (!normalized.length) throw new PublicHttpsTransportError();
  return normalized;
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function pinnedRequestOptions(destination, candidate, options = {}) {
  const tlsHost = hostAddress(destination.hostname);
  return {
    ...options,
    agent: false,
    lookup: pinnedLookup(candidate.address, candidate.family),
    ...(isIP(tlsHost) ? {} : { servername: tlsHost }),
  };
}

function trackSecureConnect(request, attempt) {
  request?.once?.('socket', (socket) => {
    socket?.once?.('secureConnect', () => { attempt.secureConnected = true; });
  });
}

function appendResponseHeaders(target, source) {
  for (const [name, value] of Object.entries(source || {})) {
    if (Array.isArray(value)) for (const item of value) target.append(name, String(item));
    else if (value !== undefined) target.append(name, String(value));
  }
}

function identityEncodedHeaders(headers) {
  const normalized = Object.fromEntries(new Headers(headers).entries());
  delete normalized['content-length'];
  normalized['accept-encoding'] = 'identity';
  return normalized;
}

async function fetchFromCandidate(destination, candidate, options, request) {
  const { method, headers, body, signal, maxResponseBytes, attempt } = options;
  if (signal?.aborted) throw new PublicHttpsTransportError();
  try {
    return await withAbort(new Promise((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new PublicHttpsTransportError());
      };
      let req;
      try {
        req = request(destination, pinnedRequestOptions(destination, candidate, { method, headers, signal }), (response) => {
          attempt.responseStarted = true;
          const chunks = [];
          let totalBytes = 0;
          response.on?.('data', (chunk) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.byteLength;
            if (totalBytes > maxResponseBytes) {
              response.destroy?.();
              fail();
              return;
            }
            chunks.push(bytes);
          });
          response.once?.('error', fail);
          response.once?.('end', () => {
            if (settled) return;
            const status = Number(response.statusCode) || 0;
            if (status < 200 || status > 599) return fail();
            const responseHeaders = new Headers();
            appendResponseHeaders(responseHeaders, response.headers);
            const responseBody = status === 204 || status === 205 || status === 304
              ? null
              : (chunks.length ? Buffer.concat(chunks) : null);
            try {
              settled = true;
              resolve(new Response(responseBody, { status, headers: responseHeaders }));
            } catch {
              fail();
            }
          });
        });
      } catch {
        fail();
        return;
      }
      trackSecureConnect(req, attempt);
      req.once?.('error', fail);
      if (body === undefined || body === null) req.end();
      else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(body);
      else if (body instanceof URLSearchParams) req.end(Buffer.from(body.toString(), 'utf8'));
      else if (body instanceof ArrayBuffer) req.end(new Uint8Array(body));
      else fail();
    }), signal);
  } catch (error) {
    if (error instanceof PublicHttpsTransportError) throw error;
    throw new PublicHttpsTransportError();
  }
}

function methodMayReplay(method) {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Build a bounded public-HTTPS transport for server-side metadata and token flows.
 * DNS is resolved afresh, every answer must be public, each socket is pinned to a
 * validated address, SNI keeps the original hostname, pooling and redirects are
 * disabled, and response buffering is bounded. Mutating requests are never
 * replayed after TLS establishment or response headers because delivery is then
 * ambiguous.
 */
export function createPublicHttpsTransport({ lookup = dnsLookup, request = httpsRequest } = {}) {
  if (typeof lookup !== 'function' || typeof request !== 'function') {
    throw new TypeError('public HTTPS transport dependencies must be functions');
  }
  return Object.freeze({
    async fetch(url, {
      method = 'GET', headers = {}, body, signal, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    } = {}) {
      const destination = new URL(validatePublicHttpsUrl(url));
      if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        throw new TypeError('maxResponseBytes must be a positive safe integer');
      }
      const candidates = await resolvePublicAddresses(destination, lookup, signal);
      const requestHeaders = identityEncodedHeaders(headers);
      const requestMethod = String(method || 'GET').toUpperCase();
      let lastError;
      for (const candidate of candidates) {
        const attempt = { responseStarted: false, secureConnected: false };
        try {
          return await fetchFromCandidate(destination, candidate, {
            method: requestMethod, headers: requestHeaders, body, signal, maxResponseBytes, attempt,
          }, request);
        } catch (error) {
          if (!(error instanceof PublicHttpsTransportError)) throw error;
          lastError = error;
          if (signal?.aborted || attempt.responseStarted || (attempt.secureConnected && !methodMayReplay(requestMethod))) {
            throw error;
          }
        }
      }
      throw lastError || new PublicHttpsTransportError();
    },
  });
}

let activeTransport = createPublicHttpsTransport();

/** Fetch through ScopeWeave's process-wide pinned public-HTTPS transport. */
export function fetchPublicHttps(url, options) {
  return activeTransport.fetch(url, options);
}

/** Replace the outbound transport only in explicit test processes. */
export function configurePublicHttpsTransportForTests(transport) {
  if (process.env.NODE_ENV !== 'test') throw new Error('public HTTPS transport override is test-only');
  if (!transport || typeof transport.fetch !== 'function') throw new TypeError('test transport must expose fetch');
  activeTransport = transport;
}
