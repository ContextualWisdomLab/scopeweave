import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Extract the functions from app.js as they are not exported
const appJsPath = path.resolve('app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Find and extract the functions
const extractFunction = (name) => {
  const startRegex = new RegExp(`function ${name}\\([^)]+\\)\\s*{`);
  const match = appJsContent.match(startRegex);
  if (!match) throw new Error(`Function ${name} not found`);

  const startIndex = match.index;
  let endIndex = startIndex;
  let braceCount = 0;
  let started = false;

  for (let i = startIndex; i < appJsContent.length; i++) {
    if (appJsContent[i] === '{') {
      braceCount++;
      started = true;
    } else if (appJsContent[i] === '}') {
      braceCount--;
    }

    if (started && braceCount === 0) {
      endIndex = i + 1;
      break;
    }
  }

  return appJsContent.substring(startIndex, endIndex);
};

// Create a context to execute the functions
const executeInContext = (functionString, args, context = {}) => {
  const argsNames = Object.keys(context);
  const argsValues = Object.values(context);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...argsNames, `
    ${functionString}
    return ${functionString.match(/function\s+([a-zA-Z0-9_]+)/)[1]}(...arguments);
  `);
  return fn(...argsValues, ...args);
};

const formatDateInputCode = extractFunction('formatDateInput');
const formatLocalDateInputCode = extractFunction('formatLocalDateInput');
const formatCompactDateCode = extractFunction('formatCompactDate');

const date1 = new Date(Date.UTC(2026, 0, 5)); // Jan 5, 2026 (Month 1, Day 5 - padding needed)
const date2 = new Date(Date.UTC(2026, 11, 25)); // Dec 25, 2026 (Month 12, Day 25 - no padding needed)
const localDate1 = new Date(2026, 0, 5);
const localDate2 = new Date(2026, 11, 25);

const formatDateInput_padded = executeInContext(formatDateInputCode, [date1]);
const formatDateInput_unpadded = executeInContext(formatDateInputCode, [date2]);
const formatLocalDateInput_padded = executeInContext(formatLocalDateInputCode, [localDate1]);
const formatLocalDateInput_unpadded = executeInContext(formatLocalDateInputCode, [localDate2]);
const formatCompactDate_padded = executeInContext(formatCompactDateCode, [localDate1]);
const formatCompactDate_unpadded = executeInContext(formatCompactDateCode, [localDate2]);

assert.equal(formatDateInput_padded, '2026-01-05');
assert.equal(formatDateInput_unpadded, '2026-12-25');
assert.equal(formatLocalDateInput_padded, '2026-01-05');
assert.equal(formatLocalDateInput_unpadded, '2026-12-25');
assert.equal(formatCompactDate_padded, '20260105');
assert.equal(formatCompactDate_unpadded, '20261225');

console.log('✓ Date formatting unit tests passed');
