import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const { app } = await import('../../server/app.mjs');

const requestJson = (path, payload) => app.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const knownEmail = 'timing-known@example.test';
const knownPassword = 'correct-password-123';

let response = await requestJson('/api/auth/signup', {
  email: knownEmail,
  password: knownPassword,
  name: 'Timing Contract',
});
assert.equal(response.status, 200, 'timing fixture signup succeeds');

async function measuredRejectedLogin(email) {
  const startedAt = process.hrtime.bigint();
  const result = await requestJson('/api/auth/login', {
    email,
    password: 'definitely-wrong-password',
  });
  const elapsedNs = Number(process.hrtime.bigint() - startedAt);
  assert.equal(result.status, 401, 'both known and unknown accounts reject the wrong password');
  assert.deepEqual(await result.json(), { error: 'invalid credentials' });
  return elapsedNs;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

// Warm both paths so module/database initialization is not part of the comparison.
await measuredRejectedLogin(knownEmail);
await measuredRejectedLogin('timing-warmup-missing@example.test');

const knownDurations = [];
const unknownDurations = [];
for (let index = 0; index < 5; index += 1) {
  // Alternate ordering to reduce monotonic machine-load drift across the sample.
  if (index % 2 === 0) {
    unknownDurations.push(await measuredRejectedLogin(`missing-${index}@example.test`));
    knownDurations.push(await measuredRejectedLogin(knownEmail));
  } else {
    knownDurations.push(await measuredRejectedLogin(knownEmail));
    unknownDurations.push(await measuredRejectedLogin(`missing-${index}@example.test`));
  }
}

const knownMedian = median(knownDurations);
const unknownMedian = median(unknownDurations);
const workRatio = unknownMedian / knownMedian;

// This is deliberately a broad work-class contract, not a claim of constant-time
// request handling. Before the mitigation the unknown-user path skipped scrypt
// entirely and was orders of magnitude faster; both paths must now pay comparable
// password-KDF work while allowing normal scheduler/database noise in CI.
assert.ok(
  workRatio >= 0.2 && workRatio <= 5,
  `unknown-user login must retain comparable KDF work (ratio=${workRatio.toFixed(3)})`,
);

console.log('✓ auth timing work-class contract passed');
