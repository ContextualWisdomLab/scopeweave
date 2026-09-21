const fs = require('fs');
const content = fs.readFileSync('cloud-sync.js', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('for') && lines[i].includes('(') && lines[i].includes(')')) {
     if(lines[i].includes('of '))
         console.log(`cloud-sync.js:${i+1}: ${lines[i]}`);
  }
}
