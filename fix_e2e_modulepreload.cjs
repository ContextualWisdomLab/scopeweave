const fs = require('fs');
let content = fs.readFileSync('index.html', 'utf8');
const expectedLines = `    <link rel="modulepreload" href="cloud-sync.js" />
    <link rel="modulepreload" href="analytics.js" />
    <link rel="modulepreload" href="app.js" />`;

if (content.includes('<link rel="modulepreload" href="app.js" />') && !content.includes('<link rel="modulepreload" href="cloud-sync.js" />')) {
   content = content.replace('<link rel="modulepreload" href="app.js" />', expectedLines);
   fs.writeFileSync('index.html', content);
   console.log("Patched index.html");
} else {
   console.log("Already has it? ", content.includes('cloud-sync.js'));
}
