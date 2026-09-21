const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');

if (!content.includes('cloud-sync.js')) {
    const search = `<link rel="stylesheet" href="styles.css" />`;
    const replace = `<link rel="modulepreload" href="cloud-sync.js" />
    <link rel="modulepreload" href="analytics.js" />
    <link rel="modulepreload" href="app.js" />
    <link rel="stylesheet" href="styles.css" />`;
    fs.writeFileSync('index.html', content.replace(search, replace), 'utf8');
    console.log("Patched index.html");
} else {
    console.log("Already has modulepreloads");
}
