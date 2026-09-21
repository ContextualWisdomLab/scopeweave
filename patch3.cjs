const fs = require('fs');
const content = fs.readFileSync('server/app.mjs', 'utf8');

const matches = [...content.matchAll(/\.find\(/g)];
console.log(".find( matches:", matches.length);

const matches2 = [...content.matchAll(/\.findIndex\(/g)];
console.log(".findIndex( matches:", matches2.length);

const lines = content.split('\n');
lines.forEach((line, i) => {
  if (line.includes('.find(') || line.includes('.findIndex(')) {
    console.log(`${i+1}: ${line}`);
  }
});
