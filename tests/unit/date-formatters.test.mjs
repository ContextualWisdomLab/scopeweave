import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');
const appSource = fs.readFileSync(appJsPath, 'utf8');

function extractFunction(name) {
  const match = appSource.match(new RegExp(`function ${name}\\(date\\) \\{[\\s\\S]*?\\n\\}`, 'm'));
  assert.ok(match, `${name} must remain defined in app.js`);
  return match[0];
}

const source = [
  extractFunction('formatDateInput'),
  extractFunction('formatLocalDateInput'),
  extractFunction('formatCompactDate'),
  'globalThis.__dateFormatters = { formatDateInput, formatLocalDateInput, formatCompactDate };',
].join('\n');
const sandbox = { Date };
sandbox.globalThis = sandbox;
vm.runInContext(source, vm.createContext(sandbox), { filename: appJsPath });
const { formatDateInput, formatLocalDateInput, formatCompactDate } = sandbox.__dateFormatters;

assert.equal(formatDateInput(new Date(Date.UTC(2026, 0, 2, 23, 59, 59))), '2026-01-02');
assert.equal(formatDateInput(new Date(Date.UTC(2026, 10, 12, 0, 0, 0))), '2026-11-12');

const localSingleDigit = new Date(2026, 0, 2, 12, 0, 0);
assert.equal(formatLocalDateInput(localSingleDigit), '2026-01-02');
assert.equal(formatCompactDate(localSingleDigit), '20260102');

const localDoubleDigit = new Date(2026, 10, 12, 12, 0, 0);
assert.equal(formatLocalDateInput(localDoubleDigit), '2026-11-12');
assert.equal(formatCompactDate(localDoubleDigit), '20261112');

const invalid = new Date(Number.NaN);
assert.equal(formatDateInput(invalid), 'NaN-NaN-NaN');
assert.equal(formatLocalDateInput(invalid), 'NaN-NaN-NaN');
assert.equal(formatCompactDate(invalid), 'NaNNaNNaN');

console.log('date formatter unit tests passed');
