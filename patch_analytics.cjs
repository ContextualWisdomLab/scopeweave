const fs = require('fs');
const content = fs.readFileSync('analytics.js', 'utf8');
const search = `  // actual EV marker at baseDate x-position (nearest timeline index)
  let idx = series.timeline.findIndex((d) => d >= baseDate);
  if (idx === -1) idx = n - 1;`;
const replace = `  // actual EV marker at baseDate x-position (nearest timeline index)
  let idx = -1;
  for (let i = 0; i < series.timeline.length; i++) {
    if (series.timeline[i] >= baseDate) {
      idx = i;
      break;
    }
  }
  if (idx === -1) idx = n - 1;`;
fs.writeFileSync('analytics.js', content.replace(search, replace), 'utf8');
