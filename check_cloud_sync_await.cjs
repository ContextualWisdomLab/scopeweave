const fs = require('fs');
const content = fs.readFileSync('cloud-sync.js', 'utf8');

const matches = [...content.matchAll(/for\s*\([^{]+\)\s*\{[^}]*await\s+[^}]*\}/g)];
for (const match of matches) {
    console.log("Found await in loop:\n", match[0]);
}
