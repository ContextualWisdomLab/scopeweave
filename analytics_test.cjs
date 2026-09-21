const fs = require('fs');
const content = fs.readFileSync('analytics.js', 'utf8');
const search = `.findIndex((d) => d >= baseDate);`;
console.log(content.includes(search));
