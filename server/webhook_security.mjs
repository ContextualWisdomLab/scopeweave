import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blockedWebhookAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blockedWebhookAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blockedWebhookAddresses.addSubnet(network, prefix, 'ipv6');
}

function bareHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function blockedSpecialHostname(hostname) {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'home.arpa'
    || hostname.endsWith('.home.arpa');
}

/**
 * Return whether an IP address is unsafe for a customer-configured webhook.
 * Invalid address strings fail closed.
 */
export function isBlockedWebhookAddress(address) {
  const family = isIP(String(address || ''));
  if (!family) return true;
  return blockedWebhookAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function resolveAllowedAddresses(hostname, resolver) {
  const host = bareHostname(hostname);
  if (!host || blockedSpecialHostname(host)) {
    throw new Error('webhook hostname is not a public destination');
  }

  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isBlockedWebhookAddress(host)) {
      throw new Error('webhook address is not public');
    }
    return [{ address: host, family: literalFamily }];
  }

  const resolved = await resolver(host, { all: true, verbatim: true });
  const answers = Array.isArray(resolved) ? resolved : [resolved];
  if (!answers.length) throw new Error('webhook hostname did not resolve');

  const normalized = answers.map((answer) => {
    const address = String(answer?.address || '');
    const family = isIP(address);
    if (!family || isBlockedWebhookAddress(address)) {
      throw new Error('webhook hostname resolved to a non-public address');
    }
    return { address, family };
  });
  return normalized;
}

/**
 * Parse and validate a webhook URL. Hostnames must resolve exclusively to
 * public addresses; user-info and non-HTTP schemes are rejected.
 */
export async function validateWebhookUrl(rawUrl, { resolver = dnsLookup } = {}) {
  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('webhook URL is invalid');
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('webhook URL must use http or https');
  }
  if (target.username || target.password) {
    throw new Error('webhook URL must not contain credentials');
  }

  await resolveAllowedAddresses(target.hostname, resolver);
  return target;
}

function pinnedLookup(resolver) {
  return (hostname, _options, callback) => {
    resolveAllowedAddresses(hostname, resolver).then(
      ([selected]) => callback(null, selected.address, selected.family),
      (error) => callback(error),
    );
  };
}

/**
 * POST one webhook request through an address-pinned transport. DNS is
 * revalidated by the socket lookup itself, redirects are never followed, and
 * keep-alive reuse is disabled so each attempt re-enters the trust boundary.
 */
export async function postWebhook(
  rawUrl,
  {
    headers = {},
    body = '',
    timeoutMs = 3000,
    resolver = dnsLookup,
    requestImpl = null,
  } = {},
) {
  const target = await validateWebhookUrl(rawUrl, { resolver });
  const request = requestImpl || (target.protocol === 'https:' ? httpsRequest : httpRequest);

  return new Promise((resolve, reject) => {
    const req = request(target, {
      method: 'POST',
      headers,
      agent: false,
      autoSelectFamily: false,
      lookup: pinnedLookup(resolver),
    }, (res) => {
      const status = Number(res.statusCode || 0);
      res.resume();
      resolve({ status, ok: status >= 200 && status < 300 });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('webhook request timed out')));
    req.end(body);
  });
}
