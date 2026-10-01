const net = require('node:net');
const ipv4Block = new net.BlockList();
ipv4Block.addSubnet('127.0.0.0', 8);
console.log(ipv4Block.check('127.0.0.1'));
