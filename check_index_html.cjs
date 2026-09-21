const fs = require('fs');
let content = fs.readFileSync('index.html', 'utf8');
console.log(content.substring(0, 500));
