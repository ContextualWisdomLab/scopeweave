const fs = require('fs');
const content = fs.readFileSync('server/app.mjs', 'utf8');
const lines = content.split('\n');

for (let i=0; i<lines.length; i++) {
  if (lines[i].includes('for (') || lines[i].includes('for(') || lines[i].includes('while(') || lines[i].includes('while (')) {
     let foundAwait = false;
     let depth = 0;
     for (let j=i; j<lines.length; j++) {
        if (lines[j].includes('{')) depth += (lines[j].match(/{/g) || []).length;
        if (lines[j].includes('}')) depth -= (lines[j].match(/}/g) || []).length;
        if (j > i && lines[j].includes('await ')) {
            console.log(`server/app.mjs:${i+1} loop has await at line ${j+1}: ${lines[j]}`);
        }
        if (j > i && depth <= 0) break;
     }
  }
}
