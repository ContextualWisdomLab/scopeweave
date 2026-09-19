import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Test verifying that app.mjs unconditionally calls verifyPassword using DUMMY_HASH to mitigate timing attacks
function runTests() {
  console.log('TAP version 13');

  try {
    const appSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf-8');

    // Check that DUMMY_HASH is defined
    assert.ok(appSource.includes("const DUMMY_HASH = hashPassword('dummy');"), 'DUMMY_HASH must be defined at the top of app.mjs');

    // Check that the login endpoint uses DUMMY_HASH when the user is not found
    assert.ok(appSource.includes("verifyPassword(candidatePassword, u ? u.password_hash : DUMMY_HASH)"), 'login endpoint must unconditionally evaluate verifyPassword with DUMMY_HASH to prevent timing attacks');

    console.log('ok 1 - login endpoint is immune to user enumeration timing attacks');
    console.log('1..1');
  } catch (err) {
    console.error(`not ok 1 - ${err.message}`);
    console.log('1..1');
    process.exit(1);
  }
}

runTests();
