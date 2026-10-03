import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');
blockedAddresses.addSubnet('ff00::', 8, 'ipv6');

/** A webhook URL is invalid, unresolved, or resolves to a blocked address. */
export class WebhookTargetBlockedError extends Error {}

function isBlockedAddress({ address, family }) {
  const actualFamily = isIP(address);
  if (actualFamily !== family || ![4, 6].includes(actualFamily)) return true;
  return blockedAddresses.check(address, actualFamily === 4 ? 'ipv4' : 'ipv6');
}

async function resolvePublicAddresses(url, lookupAddresses) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new WebhookTargetBlockedError('webhook target must be an HTTP(S) URL without credentials');
  }

  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupAddresses(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new WebhookTargetBlockedError('webhook target did not resolve exclusively to public addresses');
  }
  return { target, addresses };
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * POST a webhook after resolving once and pinning the validated addresses.
 *
 * The optional dependency object exists for deterministic security tests.
 */
export async function postPinnedWebhook(
  url,
  { headers = {}, body = '', signal } = {},
  {
    lookupAddresses = lookup,
    httpRequest: requestHttp = httpRequest,
    httpsRequest: requestHttps = httpsRequest,
  } = {},
) {
  let resolved;
  try {
    resolved = await resolvePublicAddresses(url, lookupAddresses);
  } catch (error) {
    if (error instanceof WebhookTargetBlockedError) throw error;
    throw new WebhookTargetBlockedError('webhook target DNS resolution failed', { cause: error });
  }

  const { target, addresses } = resolved;
  const request = target.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const outgoing = request(target, {
      method: 'POST',
      headers,
      signal,
      lookup: pinnedLookup(addresses),
    }, (response) => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => {
        const status = response.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300 });
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}
