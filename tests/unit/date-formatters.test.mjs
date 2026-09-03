import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const appPath = resolve('app.js');
const appSource = readFileSync(appPath, 'utf8');

function loadFunction(name) {
  const marker = `function ${name}(`;
  const start = appSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must remain defined in app.js`);

  let depth = 0;
  let opened = false;
  let end = -1;
  for (let index = appSource.indexOf('{', start); index < appSource.length; index += 1) {
    if (appSource[index] === '{') {
      depth += 1;
      opened = true;
    } else if (appSource[index] === '}') {
      depth -= 1;
      if (opened && depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `${name} must have a complete function body`);

  const source = appSource.slice(start, end);
  const lineOffset = appSource.slice(0, start).split('\n').length - 1;
  return new vm.Script(`(${source})`, {
    filename: appPath,
    lineOffset,
  }).runInThisContext();
}

const formatDateInput = loadFunction('formatDateInput');
const formatLocalDateInput = loadFunction('formatLocalDateInput');
const formatCompactDate = loadFunction('formatCompactDate');

assert.equal(formatDateInput(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
assert.equal(formatDateInput(new Date(Date.UTC(2026, 10, 15))), '2026-11-15');

assert.equal(formatLocalDateInput(new Date(2026, 0, 5, 12, 0, 0)), '2026-01-05');
assert.equal(formatLocalDateInput(new Date(2026, 10, 15, 12, 0, 0)), '2026-11-15');
assert.equal(formatCompactDate(new Date(2026, 0, 5, 12, 0, 0)), '20260105');
assert.equal(formatCompactDate(new Date(2026, 10, 15, 12, 0, 0)), '20261115');

const invalid = new Date(Number.NaN);
assert.equal(formatDateInput(invalid), 'NaN-NaN-NaN');
assert.equal(formatLocalDateInput(invalid), 'NaN-NaN-NaN');
assert.equal(formatCompactDate(invalid), 'NaNNaNNaN');

console.log('date formatter tests passed');
