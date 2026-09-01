import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const nonPublicAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) nonPublicAddresses.addSubnet(network, prefix, 'ipv4');

for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) nonPublicAddresses.addSubnet(network, prefix, 'ipv6');

nonPublicAddresses.addAddress('::1', 'ipv6');

function normalizedHostname(url) {
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function assertPublicAddress(address) {
  const family = isIP(address);
  if (!family) throw new Error('DNS returned a non-IP webhook destination');
  if (nonPublicAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error('Webhook destination is not globally routable');
  }
  return family;
}

/**
 * Parse and validate the stable, user-supplied portion of an outbound webhook URL.
 *
 * ScopeWeave accepts only HTTPS endpoints without embedded credentials. Literal IP
 * destinations are checked against the IANA/RFC 6890 special-purpose ranges at
 * registration time, while DNS names are deliberately not guessed from their label
 * text. DNS answers are validated again at the actual socket boundary by
 * {@link createValidatedLookup}, which is the authoritative SSRF control for names.
 *
 * @param {unknown} value Candidate webhook URL supplied by an organization manager.
 * @returns {URL} A parsed HTTPS URL suitable for canonical persistence and delivery.
 * @throws {Error} When parsing fails, the scheme/credentials are unsafe, or a literal
 *   host is local, private, special-purpose, link-local, multicast, or otherwise
 *   outside the permitted globally-routable destination set.
 * @security Validation is fail-closed. It never performs network I/O and must be paired
 *   with delivery-time DNS validation so DNS rebinding cannot bypass registration.
 */
export function validateWebhookUrl(value) {
  if (typeof value !== 'string') throw new Error('Webhook URL must be a string');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS');
  if (url.username || url.password) throw new Error('Webhook URL credentials are not allowed');

  const host = normalizedHostname(url);
  if (!host) throw new Error('Webhook URL hostname is required');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Webhook URL localhost destinations are not allowed');
  }

  const family = isIP(host);
  if (family) assertPublicAddress(host);
  else if (url.hostname.endsWith('.')) url.hostname = host;
  return url;
}

/**
 * Build a DNS lookup function that pins each outbound connection to validated answers.
 *
 * The resolver is invoked once per request with `all: true`; every returned address is
 * checked before any address is handed to `https.request`. Rejecting a mixed public and
 * non-public answer set prevents DNS rotation/rebinding from selecting a private result.
 * Supplying the validated lookup directly to the socket layer avoids a second unvalidated
 * DNS resolution between policy evaluation and connection establishment.
 *
 * @param {typeof dnsLookup} resolver Node-compatible DNS resolver; injectable for tests.
 * @returns {typeof dnsLookup} A lookup callback compatible with `https.request`.
 * @sideeffect Performs OS-backed DNS resolution when invoked.
 * @throws {Error} Via the callback when resolution fails, returns no acceptable answer,
 *   or any returned address is outside the globally-routable destination set.
 * @security Fails closed on resolver errors, empty/mixed answers, and family mismatch.
 * @concurrency The callback owns no mutable request-global state and is safe for concurrent
 *   webhook deliveries; each request receives a fresh resolver invocation.
 */
export function createValidatedLookup(resolver = dnsLookup) {
  return (hostname, rawOptions, callback) => {
    const options = typeof rawOptions === 'number' ? { family: rawOptions } : (rawOptions || {});
    resolver(hostname, {
      family: options.family || 0,
      hints: options.hints || 0,
      all: true,
      order: 'verbatim',
    }, (error, rawAnswers) => {
      if (error) return callback(error);
      const answers = Array.isArray(rawAnswers) ? rawAnswers : (rawAnswers ? [rawAnswers] : []);
      try {
        if (!answers.length) throw new Error('DNS returned no webhook destination');
        for (const answer of answers) assertPublicAddress(answer.address);
        const eligible = options.family ? answers.filter((answer) => answer.family === options.family) : answers;
        if (!eligible.length) throw new Error('DNS returned no address for the requested family');
        if (options.all) return callback(null, eligible);
        return callback(null, eligible[0].address, eligible[0].family);
      } catch (validationError) {
        return callback(validationError);
      }
    });
  };
}

/**
 * Deliver one signed webhook POST through the hardened outbound network adapter.
 *
 * The adapter intentionally uses Node's HTTPS client rather than a redirect-following
 * high-level fetch. Redirects therefore remain terminal 3xx responses and can never move
 * a validated request to an unvalidated destination. `agent: false` forces a new socket
 * and DNS validation for every attempt, including retries and rows persisted before this
 * policy existed. TLS certificate verification remains at Node's secure default.
 *
 * @param {string} url Persisted webhook destination; it is revalidated on every attempt.
 * @param {{headers?: Record<string,string>, body?: string, timeoutMs?: number,
 *   lookup?: typeof dnsLookup, request?: typeof httpsRequest}} options Delivery options
 *   and injectable network seams used by deterministic tests.
 * @returns {Promise<{status:number, ok:boolean}>} HTTP status and 2xx success classification.
 * @sideeffect Resolves DNS, opens an HTTPS socket, and transmits the supplied signed body.
 * @throws {Error} When URL/DNS/TLS/socket validation fails or the request times out.
 * @security Never follows redirects and never sends credentials/body to an address that did
 *   not pass the connection-time global-routability gate.
 * @concurrency Each invocation owns its request/socket and shares only immutable policy data.
 */
export function postWebhook(url, {
  headers = {},
  body = '',
  timeoutMs = 3000,
  lookup = dnsLookup,
  request = httpsRequest,
} = {}) {
  const destination = validateWebhookUrl(url);
  const validatedLookup = createValidatedLookup(lookup);

  return new Promise((resolve, reject) => {
    const outboundRequest = request(destination, {
      method: 'POST',
      headers,
      lookup: validatedLookup,
      agent: false,
    }, (response) => {
      const status = response.statusCode || 0;
      response.resume();
      resolve({ status, ok: status >= 200 && status < 300 });
    });

    outboundRequest.setTimeout(timeoutMs, () => {
      outboundRequest.destroy(new Error('Webhook request timed out'));
    });
    outboundRequest.once('error', reject);
    outboundRequest.end(body);
  });
}
