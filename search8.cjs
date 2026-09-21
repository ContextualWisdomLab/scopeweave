const fs = require('fs');
const content = fs.readFileSync('cloud-sync.js', 'utf8');

const matches = [...content.matchAll(/Array\.prototype\.findIndex|Array\.prototype\.find/g)];
console.log("find/findIndex matches:", matches.length);

const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('find(')) {
    console.log(`cloud-sync.js:${i+1}: ${lines[i]}`);
  }
}
