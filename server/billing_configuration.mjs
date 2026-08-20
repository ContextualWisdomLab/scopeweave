const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const STRIPE_CONFIGURATION_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
];

/** Stable, machine-classifiable failure for billing startup configuration. */
export class BillingConfigurationError extends Error {
  /**
   * Create a safe billing configuration error.
   *
   * @param {string} code - Stable machine-readable failure code.
   */
  constructor(code) {
    super(code);
    this.name = 'BillingConfigurationError';
    this.code = code;
  }
}

function configuredValue(env, key) {
  return String(env[key] || '').trim();
}

function parsePublicOrigin(rawValue, developmentMode) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new BillingConfigurationError('billing_public_origin_invalid');
  }

  const hasAmbiguousComponents = Boolean(
    url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash,
  );
  if (hasAmbiguousComponents) {
    throw new BillingConfigurationError('billing_public_origin_invalid');
  }

  const secure = url.protocol === 'https:';
  const loopbackDevelopmentHttp = developmentMode
    && url.protocol === 'http:'
    && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!secure && !loopbackDevelopmentHttp) {
    throw new BillingConfigurationError('billing_public_origin_invalid');
  }

  return url.origin;
}

/**
 * Resolve the billing capability state from process-style environment values.
 *
 * Production never falls back to a successful mock. A live Stripe capability
 * requires the complete provider key/price/webhook tuple plus an operator-owned
 * canonical public origin. Explicit development mode may use the mock, but the
 * same public-origin contract prevents request Host headers from becoming
 * Checkout redirect authority.
 *
 * @param {Record<string, string | undefined>} [env=process.env] - Environment values.
 * @returns {{mode: 'disabled' | 'mock' | 'live', publicOrigin: string | null}}
 *   Validated billing mode and canonical public origin.
 * @throws {BillingConfigurationError} When provider settings are partial or the
 *   configured public origin is absent/ambiguous/insecure.
 */
export function validateBillingStartupConfiguration(env = process.env) {
  const developmentMode = env.SCOPEWEAVE_DEV === '1';
  const stripeValues = STRIPE_CONFIGURATION_KEYS.map((key) => configuredValue(env, key));
  const configuredCount = stripeValues.filter(Boolean).length;
  const liveStripeConfigured = configuredCount === STRIPE_CONFIGURATION_KEYS.length;

  if (configuredCount > 0 && !liveStripeConfigured) {
    throw new BillingConfigurationError('billing_configuration_incomplete');
  }

  const publicOriginInput = configuredValue(env, 'SCOPEWEAVE_PUBLIC_ORIGIN');
  if (liveStripeConfigured && !publicOriginInput) {
    throw new BillingConfigurationError('billing_public_origin_required');
  }

  const publicOrigin = publicOriginInput
    ? parsePublicOrigin(publicOriginInput, developmentMode)
    : null;

  if (liveStripeConfigured) {
    return { mode: 'live', publicOrigin };
  }
  if (developmentMode && publicOrigin) {
    return { mode: 'mock', publicOrigin };
  }
  return { mode: 'disabled', publicOrigin };
}
