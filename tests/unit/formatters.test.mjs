import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const appCode = fs.readFileSync(path.join(process.cwd(), 'app.js'), 'utf-8');

function extractFunction(name) {
  const startStr = `function ${name}(`;
  let startIdx = appCode.indexOf(startStr);
  if (startIdx === -1) return '';
  let endIdx = appCode.indexOf('\n}', startIdx);
  if (endIdx === -1) return '';
  return appCode.substring(startIdx, endIdx + 2);
}

const f1 = extractFunction('formatDateInput');
const f2 = extractFunction('formatLocalDateInput');
const f3 = extractFunction('formatCompactDate');

const sandbox = {};
runInNewContext(f1 + '\n' + f2 + '\n' + f3 + '\n' + `
  this.formatDateInput = formatDateInput;
  this.formatLocalDateInput = formatLocalDateInput;
  this.formatCompactDate = formatCompactDate;
`, sandbox);

test('formatDateInput formats dates correctly', () => {
  const d = new Date(Date.UTC(2024, 4, 6)); // May 6, 2024
  assert.strictEqual(sandbox.formatDateInput(d), '2024-05-06');
  const d2 = new Date(Date.UTC(2024, 10, 20)); // Nov 20, 2024
  assert.strictEqual(sandbox.formatDateInput(d2), '2024-11-20');
});

test('formatLocalDateInput formats dates correctly', () => {
  const d = new Date(2024, 4, 6); // May 6, 2024
  assert.strictEqual(sandbox.formatLocalDateInput(d), '2024-05-06');
  const d2 = new Date(2024, 10, 20); // Nov 20, 2024
  assert.strictEqual(sandbox.formatLocalDateInput(d2), '2024-11-20');
});

test('formatCompactDate formats dates correctly', () => {
  const d = new Date(2024, 4, 6); // May 6, 2024
  assert.strictEqual(sandbox.formatCompactDate(d), '20240506');
  const d2 = new Date(2024, 10, 20); // Nov 20, 2024
  assert.strictEqual(sandbox.formatCompactDate(d2), '20241120');
});
