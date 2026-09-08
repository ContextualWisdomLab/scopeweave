import assert from 'node:assert';
import { readFileSync } from 'node:fs';

console.log('TAP version 13');

const syncCode = readFileSync('./cloud-sync.js', 'utf8');

// The optimization requires a Map to be instantiated prior to the loop.
const mapPattern = /const\s+\w+\s*=\s*new\s+Map\([^)]*host\?\.getState\?\.\(\)\?\.tasks[^)]*\)/;

if (mapPattern.test(syncCode)) {
  console.log('ok 1 - cloud-sync.js uses O(1) Map for task name resolution in modals');
} else {
  console.log('not ok 1 - cloud-sync.js does not use O(1) Map for task name resolution in modals');
}

console.log('1..1');
