const fs = require('fs');
let journal = '';
if (fs.existsSync('.jules/bolt.md')) {
   journal = fs.readFileSync('.jules/bolt.md', 'utf8');
}
const date = new Date().toISOString().split('T')[0];
journal += `\n## ${date} - Replaced findIndex with explicit loops\n**Learning:** In hot render paths, using \`Array.prototype.findIndex()\` incurs an O(N) array scan per call. Converting these calls to explicit \`for\` loops improves iteration speed over large collections without the memory overhead of constructing an O(1) \`Map\` for one-off lookups, avoiding a net pessimization.\n**Action:** Replaced \`.findIndex()\` with explicit \`for\` loops where one-off scans were occurring (e.g., in \`app.js\` and \`analytics.js\`).\n`;
fs.mkdirSync('.jules', { recursive: true });
fs.writeFileSync('.jules/bolt.md', journal);
