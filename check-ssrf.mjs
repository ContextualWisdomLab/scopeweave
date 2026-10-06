import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';

const blockList = new BlockList();
blockList.addAddress('127.0.0.1');
blockList.addAddress('0.0.0.0');
blockList.addAddress('::1', 'ipv6');
blockList.addAddress('::', 'ipv6');
blockList.addSubnet('10.0.0.0', 8);
blockList.addSubnet('172.16.0.0', 12);
blockList.addSubnet('192.168.0.0', 16);
blockList.addSubnet('fc00::', 7, 'ipv6');
blockList.addSubnet('fe80::', 10, 'ipv6');

async function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

    // Check hostname
    let hostname = u.hostname;
    hostname = hostname.replace(/^\[|\]$/g, '');

    const ips = await lookup(hostname, { all: true });

    for (const { address, family } of ips) {
      if (blockList.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
        return false;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

console.log(await isSafeUrl('http://127.0.0.1'));
console.log(await isSafeUrl('http://google.com'));
console.log(await isSafeUrl('http://localhost'));
