const fs = require('fs');
const content = fs.readFileSync('cloud-sync.js', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('for (') && lines[i].includes('of')) {
    console.log(`${i+1}: ${lines[i]}`);
  }
}
