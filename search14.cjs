const fs = require('fs');
const content = fs.readFileSync('server/app.mjs', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('.find(') || lines[i].includes('.findIndex(')) {
    console.log(`server/app.mjs:${i+1}: ${lines[i]}`);
  }
}
