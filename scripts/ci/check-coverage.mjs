import { readFile } from 'node:fs/promises';

const summary = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8'));
const failed = ['lines', 'statements', 'functions', 'branches'].filter((metric) => Number(summary[metric].pct) < 100);

if (failed.length) {
  throw new Error(`Coverage below 100%: ${failed.join(', ')}`);
}

console.log('Coverage meets the 100% lines, statements, functions, and branches threshold.');
