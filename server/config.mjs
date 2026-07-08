// Centralized configuration. This is the ONLY module that reads process.env —
// every other server module imports typed, validated values from here. Rationale:
//   - one place to see (and document) every knob the service reads;
//   - one place to enforce security invariants (no insecure default secret);
//   - trivially swappable for a KV / secrets-manager backend in prod (replace the
//     `env()` accessor below; the rest of the app never touches process.env).
//
// ponytail: keep this file dependency-free and side-effect-light so it can be
// imported from tests and tools without booting the server.
import { randomBytes } from 'node:crypto';

// Single choke point for raw environment access. Swap this body for a call into
// Vault / AWS Secrets Manager / Doppler etc. without changing any caller.
const env = (key) => process.env[key];

const bool = (v) => v === '1' || v === 'true';
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && v != null && v !== '' ? n : dflt;
};

const NODE_ENV = env('NODE_ENV') || 'development';
const isProd = NODE_ENV === 'production';

// --- JWT signing secret ------------------------------------------------------
// SECURITY: there is deliberately NO shared hardcoded default. In production an
// unset/weak secret is fatal (fail closed). In dev/test we mint a random,
// process-ephemeral secret so the flow stays self-contained — tokens simply do
// not survive a restart, which is exactly what you want for a throwaway secret.
function loadJwtSecret() {
  const s = env('SCOPEWEAVE_JWT_SECRET');
  if (s && s.length >= 16) return s;
  if (isProd) {
    throw new Error(
      'SCOPEWEAVE_JWT_SECRET is required (min 16 chars) in production — refusing to start with an insecure secret',
    );
  }
  if (s) console.warn('[config] SCOPEWEAVE_JWT_SECRET too short (<16 chars) — using an ephemeral dev secret instead');
  else console.warn('[config] SCOPEWEAVE_JWT_SECRET unset — generated an ephemeral dev secret (tokens reset on restart)');
  return randomBytes(32).toString('hex');
}

export const config = {
  nodeEnv: NODE_ENV,
  isProd,
  // dev conveniences (never true in prod unless explicitly set)
  devMode: bool(env('SCOPEWEAVE_DEV')),

  server: {
    port: num(env('PORT'), 8787),
  },

  db: {
    // ':memory:' during tests; a file path otherwise.
    path: env('SCOPEWEAVE_DB') || null, // db.mjs resolves null → ../data.db
    inMemory: String(env('SCOPEWEAVE_DB') || '').includes(':memory:'),
  },

  auth: {
    jwtSecret: loadJwtSecret(),
  },

  rateLimit: {
    max: num(env('SCOPEWEAVE_RATE_LIMIT_MAX'), 0), // 0 = disabled
    windowMs: num(env('SCOPEWEAVE_RATE_LIMIT_WINDOW_MS'), 60000),
  },

  billing: {
    stripeSecretKey: env('STRIPE_SECRET_KEY') || '',
    stripePriceId: env('STRIPE_PRICE_ID') || '',
    stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET') || '',
  },

  oidc: {
    issuer: env('OIDC_ISSUER') || '',
    clientId: env('OIDC_CLIENT_ID') || '',
    clientSecret: env('OIDC_CLIENT_SECRET') || '',
    redirectUri: env('OIDC_REDIRECT_URI') || '',
  },

  clearfolio: {
    url: (env('CLEARFOLIO_URL') || '').replace(/\/$/, ''),
    hmacSecret: env('CLEARFOLIO_HMAC_SECRET') || '',
  },

  orchestrator: {
    url: (env('ORCHESTRATOR_URL') || '').replace(/\/$/, ''),
    token: env('ORCHESTRATOR_TOKEN') || '',
  },
};
