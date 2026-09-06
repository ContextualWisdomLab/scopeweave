import dns from 'node:dns';
import net from 'node:net';

const blockedWebhookIps = new net.BlockList();
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
]) {
  blockedWebhookIps.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  blockedWebhookIps.addSubnet(network, prefix, 'ipv6');
}

const rfc6052WellKnownPrefix = new net.BlockList();
rfc6052WellKnownPrefix.addSubnet('64:ff9b::', 96, 'ipv6');

function normalizeHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

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

export function isPublicWebhookIp(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  // RFC 6052 makes the WKP globally reachable only for globally reachable embedded IPv4 destinations.
  if (family === 6 && rfc6052WellKnownPrefix.check(address, 'ipv6')) {
    const embeddedIpv4 = rfc6052EmbeddedIpv4(address);
    return embeddedIpv4 !== null && isPublicWebhookIp(embeddedIpv4);
  }
  return !blockedWebhookIps.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function isSafeWebhookUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = normalizeHostname(url.hostname);
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      return false;
    }
    return net.isIP(hostname) === 0 || isPublicWebhookIp(hostname);
  } catch {
    return false;
  }
}

function selectPublicWebhookAddress(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('No addresses found');
  let selected = null;
  for (const candidate of addresses) {
    const address = candidate?.address;
    const family = Number(candidate?.family);
    if ((family !== 4 && family !== 6) || net.isIP(address) !== family || !isPublicWebhookIp(address)) {
      throw new Error('SSRF blocked');
    }
    if (selected === null) selected = { address, family };
  }
  return selected;
}

export function createSafeWebhookLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const callerOptions = options && typeof options === 'object' ? options : {};
    const lookupOptions = { ...callerOptions, family: 0, all: true };
    resolve(hostname, lookupOptions, (error, addresses) => {
      if (error) return callback(error);
      let selected;
      try {
        selected = selectPublicWebhookAddress(addresses);
      } catch (selectionError) {
        return callback(selectionError);
      }
      if (callerOptions.all === true) return callback(null, [selected]);
      return callback(null, selected.address, selected.family);
    });
  };
}
