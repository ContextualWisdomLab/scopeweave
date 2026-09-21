const fs = require('fs');
const content = fs.readFileSync('app.js', 'utf8');

const matches = [...content.matchAll(/Array\.prototype\.findIndex|Array\.prototype\.find/g)];
console.log("find/findIndex matches:", matches.length);
