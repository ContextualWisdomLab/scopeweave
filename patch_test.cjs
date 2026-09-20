const fs = require('fs');
const content = fs.readFileSync('app.js', 'utf8');
const counts = {
  documentCreateElement: (content.match(/document\.createElement/g) || []).length,
  cloneNode: (content.match(/\.cloneNode/g) || []).length
};
console.log(counts);
