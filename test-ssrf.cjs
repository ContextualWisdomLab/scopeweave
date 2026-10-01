const dns = require('node:dns/promises');
const net = require('node:net');

const ipv4Block = new net.BlockList();
ipv4Block.addSubnet('127.0.0.0', 8);
ipv4Block.addSubnet('10.0.0.0', 8);
ipv4Block.addSubnet('172.16.0.0', 12);
ipv4Block.addSubnet('192.168.0.0', 16);
ipv4Block.addSubnet('169.254.0.0', 16);
ipv4Block.addAddress('0.0.0.0');

const ipv6Block = new net.BlockList();
ipv6Block.addSubnet('::1', 128, 'ipv6');
ipv6Block.addSubnet('fc00::', 7, 'ipv6');
ipv6Block.addSubnet('fe80::', 10, 'ipv6');
ipv6Block.addAddress('::', 'ipv6');
// IPv4-mapped IPv6
ipv6Block.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
ipv6Block.addSubnet('::ffff:10.0.0.0', 104, 'ipv6');
ipv6Block.addSubnet('::ffff:172.16.0.0', 108, 'ipv6');
ipv6Block.addSubnet('::ffff:192.168.0.0', 112, 'ipv6');
ipv6Block.addSubnet('::ffff:169.254.0.0', 112, 'ipv6');


async function checkSSRF(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false; // invalid URL
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const hostname = u.hostname.replace(/^\[|\]$/g, '');

  let ips = [];
  if (net.isIPv4(hostname)) {
    if (ipv4Block.check(hostname)) return false;
  } else if (net.isIPv6(hostname)) {
    if (ipv6Block.check(hostname, 'ipv6')) return false;
  } else {
    try {
      const v4 = await dns.resolve4(hostname).catch(e => {
        if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') throw e;
        return [];
      });
      const v6 = await dns.resolve6(hostname).catch(e => {
        if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') throw e;
        return [];
      });
      ips = [...v4, ...v6];
    } catch (e) {
      return false; // DNS error
    }

    if (ips.length === 0) return false;

    for (const ip of ips) {
      if (net.isIPv4(ip) && ipv4Block.check(ip)) return false;
      if (net.isIPv6(ip) && ipv6Block.check(ip, 'ipv6')) return false;
    }
  }

  return true;
}

async function test() {
  console.log('127.0.0.1:', await checkSSRF('http://127.0.0.1/'));
  console.log('localhost:', await checkSSRF('http://localhost/'));
  console.log('google.com:', await checkSSRF('https://google.com/'));
  console.log('[::1]:', await checkSSRF('http://[::1]/'));
}
test();
