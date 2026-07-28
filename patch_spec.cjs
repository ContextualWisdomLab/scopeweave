const fs = require('fs');
let content = fs.readFileSync('tests/e2e/scopeweave.spec.js', 'utf8');
content = content.replace('});\n});\n\n  test(\'ScopeWeave Planner - Palette UX Enhancements - blocks form submission when save button is aria-disabled\'', '  test(\'ScopeWeave Planner - Palette UX Enhancements - blocks form submission when save button is aria-disabled\'');
content += '});\n';
fs.writeFileSync('tests/e2e/scopeweave.spec.js', content);
