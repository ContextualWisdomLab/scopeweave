const fs = require('fs');
const content = fs.readFileSync('app.js', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('for') && lines[i].includes('(') && lines[i].includes(')')) {
     if(lines[i].includes('state.tasks'))
         console.log(`app.js:${i+1}: ${lines[i]}`);
  }
}
