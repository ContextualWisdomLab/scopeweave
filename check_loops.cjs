const fs = require('fs');
const content = fs.readFileSync('server/app.mjs', 'utf8');
const lines = content.split('\n');

for (let i=0; i<lines.length; i++) {
  if (lines[i].includes('for (') || lines[i].includes('for(')) {
     // check if the loop contains 'await fetch' or something similar
     let foundAwait = false;
     for (let j=i+1; j<i+15 && j<lines.length; j++) {
        if (lines[j].includes('await ') || lines[j].includes('fetch(') || lines[j].includes('orchestratorChat(') || lines[j].includes('sendWebhook(')) {
            console.log(`server/app.mjs:${i+1} loop has async/network call at line ${j+1}: ${lines[j]}`);
        }
        if (lines[j].includes('}')) {
             if (lines[j].indexOf('}') === lines[j].lastIndexOf('}')) {
                 // rough end of block
             }
        }
     }
  }
}
