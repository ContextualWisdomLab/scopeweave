import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const APP_PATH = new URL('../../app.js', import.meta.url);

function loadDateFormatters() {
  const source = fs.readFileSync(APP_PATH, 'utf8');
  const start = source.indexOf('function formatDateInput(date) {');
  const end = source.indexOf('\nfunction formatPercent(value, digits) {', start);

  assert.notEqual(start, -1, 'formatDateInput must remain present in app.js');
  assert.notEqual(end, -1, 'date formatter block must remain bounded by formatPercent');

  return new Function(
    `${source.slice(start, end)}\nreturn { formatDateInput, formatLocalDateInput, formatCompactDate };`
  )();
}

test('date formatters avoid padStart while preserving zero-padded output', () => {
  const { formatDateInput, formatLocalDateInput, formatCompactDate } = loadDateFormatters();
  const originalPadStart = String.prototype.padStart;
  String.prototype.padStart = function forbiddenPadStart() {
    throw new Error('date formatting regressed to String.prototype.padStart');
  };

  try {
    assert.equal(formatDateInput(new Date(Date.UTC(2026, 0, 2, 15, 4, 5))), '2026-01-02');
    assert.equal(formatDateInput(new Date(Date.UTC(2026, 10, 12, 15, 4, 5))), '2026-11-12');

    const singleDigitLocal = new Date(2026, 0, 2, 12, 0, 0);
    assert.equal(formatLocalDateInput(singleDigitLocal), '2026-01-02');
    assert.equal(formatCompactDate(singleDigitLocal), '20260102');

    const doubleDigitLocal = new Date(2026, 10, 12, 12, 0, 0);
    assert.equal(formatLocalDateInput(doubleDigitLocal), '2026-11-12');
    assert.equal(formatCompactDate(doubleDigitLocal), '20261112');
  } finally {
    String.prototype.padStart = originalPadStart;
  }
});
