const fs = require('fs');

function checkFile(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('.findIndex(')) {
       console.log(`${filepath}:${i+1}: ${lines[i]}`);
    }
  }
}

checkFile('app.js');
checkFile('analytics.js');
checkFile('cloud-sync.js');
