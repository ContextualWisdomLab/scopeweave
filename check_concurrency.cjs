const fs = require('fs');
const content = fs.readFileSync('cloud-sync.js', 'utf8');
const matches = [...content.matchAll(/Promise\.all/g)];
console.log("Promise.all in cloud-sync.js:", matches.length);
