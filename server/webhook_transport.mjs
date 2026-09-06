import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

const BLOCKED4 = new BlockList();
const BLOCKED6 = new BlockList();
const block4 = (network, prefix) => BLOCKED4.addSubnet(network, prefix, 'ipv4');
const block6 = (network, prefix) => BLOCKED6.addSubnet(network, prefix, 'ipv6');

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) block4(network, prefix);

for (const [network, prefix] of [
  ['::', 96], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
]) block6(network, prefix);

const RFC6052_WKP = new BlockList();
RFC6052_WKP.addSubnet('64:ff9b::', 96, 'ipv6');

const unbracket = (hostname) => hostname.startsWith('[') && hostname.endsWith(']')
  ? hostname.slice(1, -1)
  : hostname;

function expandIpv6Words(address) {
  const halves = address.toLowerCase().split('::');
  const parseHalf = (half) => {
    if (!half) return [];
    return half.split(':').flatMap((part) => {
      if (!part.includes('.')) return [Number.parseInt(part, 16)];
      const octets = part.split('.').map(Number);
      return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    });
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  return halves.length === 2
    ? [...left, ...Array(zeroCount).fill(0), ...right]
    : left;
}

function rfc6052EmbeddedIpv4(address) {
  const words = expandIpv6Words(address);
  if (words.length !== 8) return null;
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
}

export function isPublicWebhookAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && RFC6052_WKP.check(address, 'ipv6')) {
    const embeddedIpv4 = rfc6052EmbeddedIpv4(address);
    return embeddedIpv4 !== null && isPublicWebhookAddress(embeddedIpv4);
  }
  const blocked = family === 4 ? BLOCKED4 : BLOCKED6;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function parseWebhookUrl(urlText) {
  let url;
  try {
    url = new URL(String(urlText));
  } catch {
    throw new TypeError('webhook URL is invalid');
  }
  if (url.protocol !== 'https:') throw new TypeError('webhook URL must use https');
  if (url.username || url.password) throw new TypeError('webhook URL must not contain credentials');
  if (!url.hostname) throw new TypeError('webhook URL must contain a host');
  return url;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function resolvePublicWebhookTarget(urlText, {
  lookup = dnsLookup,
  dnsTimeoutMs = 1000,
} = {}) {
  const url = parseWebhookUrl(urlText);
  const hostname = unbracket(url.hostname);
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await withTimeout(
      lookup(hostname, { all: true, verbatim: true }),
      dnsTimeoutMs,
      'webhook DNS resolution timed out',
    );

  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new Error('webhook host did not resolve');
  }
  const unique = [];
  const seen = new Set();
  for (const result of resolved) {
    const address = result?.address;
    const family = Number(result?.family) || isIP(address);
    if ((family !== 4 && family !== 6) || !isPublicWebhookAddress(address)) {
      throw new Error('webhook host resolved to a non-public address');
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ address, family });
    }
  }
  return { url, hostname, addresses: unique };
}

export async function postWebhookOnce({
  url: urlText,
  headers,
  body,
  lookup = dnsLookup,
  request = httpsRequest,
  dnsTimeoutMs = 1000,
  connectTimeoutMs = 1500,
  requestTimeoutMs = 3000,
  maxResponseHeaderBytes = 16384,
}) {
  const target = await resolvePublicWebhookTarget(urlText, { lookup, dnsTimeoutMs });
  const { address, family } = target.addresses[0];
  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(new Error('webhook request timed out')), requestTimeoutMs);

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const req = request({
        protocol: 'https:',
        hostname: target.hostname,
        port: target.url.port || 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers,
        maxHeaderSize: maxResponseHeaderBytes,
        rejectUnauthorized: true,
        servername: isIP(target.hostname) ? undefined : target.hostname,
        signal: controller.signal,
        lookup: (_hostname, _options, callback) => callback(null, address, family),
      }, (response) => {
        const status = response.statusCode ?? 0;
        finish(resolve, { status, ok: status >= 200 && status < 300 });
        response.destroy();
      });

      let connectTimer;
      req.once('socket', (socket) => {
        connectTimer = setTimeout(() => req.destroy(new Error('webhook connect timed out')), connectTimeoutMs);
        socket.once('secureConnect', () => clearTimeout(connectTimer));
      });
      req.once('error', (error) => {
        clearTimeout(connectTimer);
        finish(reject, error);
      });
      req.end(body);
    });
  } finally {
    clearTimeout(overallTimer);
  }
}
