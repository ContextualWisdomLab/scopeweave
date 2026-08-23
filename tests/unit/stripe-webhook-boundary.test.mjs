import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

const SECRET = 'whsec_scopeweave_webhook_test_secret';
const NOW_SECONDS = 1_800_000_000;

const { StripeWebhookError, verifyStripeWebhookRequest } = await import(
  '../../server/stripe_webhook.mjs'
);

function signatureHeader(bodyBytes, timestamp = NOW_SECONDS, secret = SECRET, extra = '') {
  const digest = createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(bodyBytes)
    .digest('hex');
  return `t=${timestamp},v1=${digest}${extra}`;
}

function webhookRequest(bodyBytes, {
  signature = signatureHeader(bodyBytes),
  contentLength,
} = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    'stripe-signature': signature,
  });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return new Request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers,
    body: bodyBytes,
    duplex: 'half',
  });
}

function encoded(value) {
  return new TextEncoder().encode(value);
}

async function expectWebhookError(operation, code, status) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof StripeWebhookError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('verified webhook preserves the exact signed raw body and returns bounded event identity', async () => {
  const bytes = encoded('{\n  "id":"evt_scopeweave_1",\n  "type":"checkout.session.completed",\n  "data":{"object":{"client_reference_id":"7"}}\n}\n');
  const event = await verifyStripeWebhookRequest(webhookRequest(bytes), {
    secret: SECRET,
    nowSeconds: NOW_SECONDS,
  });

  assert.equal(event.id, 'evt_scopeweave_1');
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.data.object.client_reference_id, '7');
});

test('signature verification fails when JSON-equivalent bytes differ from the signed body', async () => {
  const signedBytes = encoded('{"id":"evt_raw","type":"checkout.session.completed"}');
  const mutatedBytes = encoded('{ "id": "evt_raw", "type": "checkout.session.completed" }');

  await expectWebhookError(
    () => verifyStripeWebhookRequest(webhookRequest(mutatedBytes, {
      signature: signatureHeader(signedBytes),
    }), {
      secret: SECRET,
      nowSeconds: NOW_SECONDS,
    }),
    'stripe_webhook_signature_invalid',
    400,
  );
});

test('signature parser accepts one matching v1 value and rejects malformed, missing, stale, or future signatures', async () => {
  const bytes = encoded('{"id":"evt_sig","type":"invoice.paid"}');
  const valid = signatureHeader(bytes);
  const validDigest = valid.split('v1=')[1];

  const multiple = webhookRequest(bytes, {
    signature: `t=${NOW_SECONDS},v1=${'0'.repeat(64)},v1=${validDigest}`,
  });
  assert.equal((await verifyStripeWebhookRequest(multiple, {
    secret: SECRET,
    nowSeconds: NOW_SECONDS,
  })).id, 'evt_sig');

  for (const signature of [
    '',
    `t=${NOW_SECONDS}`,
    `v1=${validDigest}`,
    `t=not-a-number,v1=${validDigest}`,
    `t=${NOW_SECONDS},v1=xyz`,
    signatureHeader(bytes, NOW_SECONDS - 301),
    signatureHeader(bytes, NOW_SECONDS + 301),
  ]) {
    const request = webhookRequest(bytes, { signature });
    await expectWebhookError(
      () => verifyStripeWebhookRequest(request, {
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
      'stripe_webhook_signature_invalid',
      400,
    );
  }
});

test('body byte ceiling rejects declared and streamed oversize requests before JSON parsing', async () => {
  const small = encoded('{"id":"evt_size","type":"invoice.paid"}');
  await expectWebhookError(
    () => verifyStripeWebhookRequest(webhookRequest(small, {
      contentLength: 262_145,
    }), {
      secret: SECRET,
      nowSeconds: NOW_SECONDS,
    }),
    'stripe_webhook_body_too_large',
    413,
  );

  const large = encoded(JSON.stringify({
    id: 'evt_stream_size',
    type: 'invoice.paid',
    data: 'x'.repeat(262_144),
  }));
  await expectWebhookError(
    () => verifyStripeWebhookRequest(webhookRequest(large), {
      secret: SECRET,
      nowSeconds: NOW_SECONDS,
    }),
    'stripe_webhook_body_too_large',
    413,
  );
});

test('invalid content length, payload JSON, event identity, and verifier configuration fail closed', async () => {
  const validBytes = encoded('{"id":"evt_valid","type":"invoice.paid"}');

  for (const contentLength of ['-1', 'NaN', '1.5', '999999999999999999999999']) {
    await expectWebhookError(
      () => verifyStripeWebhookRequest(webhookRequest(validBytes, { contentLength }), {
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
      'stripe_webhook_request_invalid',
      400,
    );
  }

  const malformed = encoded('{"id":');
  await expectWebhookError(
    () => verifyStripeWebhookRequest(webhookRequest(malformed), {
      secret: SECRET,
      nowSeconds: NOW_SECONDS,
    }),
    'stripe_webhook_payload_invalid',
    400,
  );

  for (const value of [
    null,
    [],
    {},
    { id: '', type: 'invoice.paid' },
    { id: 'evt_ok', type: '' },
    { id: 'x'.repeat(256), type: 'invoice.paid' },
    { id: 'evt_ok', type: 'x'.repeat(256) },
  ]) {
    const bytes = encoded(JSON.stringify(value));
    await expectWebhookError(
      () => verifyStripeWebhookRequest(webhookRequest(bytes), {
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
      'stripe_webhook_payload_invalid',
      400,
    );
  }

  await expectWebhookError(
    () => verifyStripeWebhookRequest(webhookRequest(validBytes), {
      secret: '   ',
      nowSeconds: NOW_SECONDS,
    }),
    'stripe_webhook_not_configured',
    503,
  );
});
