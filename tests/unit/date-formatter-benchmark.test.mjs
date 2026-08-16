import test from 'node:test';
import assert from 'node:assert';

function padStartFormatter(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ternaryFormatter(date) {
  const year = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const month = m < 10 ? '0' + m : m;
  const day = d < 10 ? '0' + d : d;
  return `${year}-${month}-${day}`;
}

test('Ternary operator is faster than padStart for date formatting in a realistic tight loop', () => {
  const iterations = 500000;
  // Use dates that represent a typical multi-year project range
  const dates = Array.from({ length: 1000 }, (_, i) => new Date(Date.UTC(2023, 0, 1) + (i * 86400000)));

  // Warmup
  for (let i = 0; i < 10000; i++) {
    padStartFormatter(dates[i % 1000]);
    ternaryFormatter(dates[i % 1000]);
  }

  let len1 = 0;
  const startPadStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    len1 += padStartFormatter(dates[i % 1000]).length;
  }
  const durationPadStart = performance.now() - startPadStart;

  let len2 = 0;
  const startTernary = performance.now();
  for (let i = 0; i < iterations; i++) {
    len2 += ternaryFormatter(dates[i % 1000]).length;
  }
  const durationTernary = performance.now() - startTernary;
  assert.strictEqual(len1, len2, 'Output lengths should match');

  console.log(`padStart execution time: ${durationPadStart.toFixed(2)}ms`);
  console.log(`Ternary execution time: ${durationTernary.toFixed(2)}ms`);

  assert.ok(durationTernary < durationPadStart, 'Ternary formatter should be faster than padStart formatter');
});
