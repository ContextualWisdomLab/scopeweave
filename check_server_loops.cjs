const fs = require('fs');
const content = fs.readFileSync('server/app.mjs', 'utf8');
const lines = content.split('\n');

for (let i=0; i<lines.length; i++) {
  if (lines[i].includes('for (') || lines[i].includes('for(')) {
     for (let j=i+1; j<lines.length && j<i+20; j++) {
        if (lines[j].includes('await ')) {
           console.log(`server/app.mjs:${i+1} loop has await at ${j+1}: ${lines[j]}`);
        }
     }
  }
}
