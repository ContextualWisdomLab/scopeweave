import assert from 'node:assert';
import { createSafeWebhookLookup } from '../../server/webhook_destination.mjs';

function runLookup(lookup) {
  return new Promise((resolve, reject) => {
    lookup('webhook.example.test', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

const stalledResolver = (_hostname, options, callback) => {
  assert.equal(options.all, true, 'guarded lookup must inspect every resolved address');
  assert.equal(options.family, 0, 'guarded lookup must request both address families');
  setTimeout(() => callback(null, [{ address: '93.184.216.34', family: 4 }]), 100);
};

const lookup = createSafeWebhookLookup(stalledResolver, { dnsTimeoutMs: 10 });
const watchdog = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('test watchdog expired before DNS admission timed out')), 50);
});

await assert.rejects(
  Promise.race([runLookup(lookup), watchdog]),
  /webhook DNS resolution timed out/,
  'a stalled DNS admission must fail closed before the request-wide timeout budget is consumed',
);

console.log('✓ webhook destination DNS timeout regression test passed');
