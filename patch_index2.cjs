const fs = require('fs');
let content = fs.readFileSync('index.html', 'utf8');

if (!content.includes('href="cloud-sync.js"')) {
    const search = `<link rel="modulepreload" href="app.js" />`;
    const replace = `<link rel="modulepreload" href="cloud-sync.js" />
    <link rel="modulepreload" href="analytics.js" />
    <link rel="modulepreload" href="app.js" />`;
    content = content.replace(search, replace);
    fs.writeFileSync('index.html', content, 'utf8');
    console.log("Patched index.html");
} else {
    console.log("Already has modulepreloads");
}
