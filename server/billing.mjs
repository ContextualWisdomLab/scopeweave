// Billing / plan configuration + checkout. Stripe is OPTIONAL — imported
// dynamically only when STRIPE_SECRET_KEY is set, so it is not a hard dependency
// (npm i stripe + keys required for live payments; without them the mock path
// keeps the whole flow testable). Plan changes only ever happen server-side.
import { config } from './config.mjs';

export const PLANS = {
  free: { name: 'Free', limits: { projects: 2, members: 3 }, priceKrw: 0 },
  pro: { name: 'Pro', limits: { projects: null, members: null }, priceKrw: 19000 }, // null = unlimited
};

export function planOf(org) {
  return PLANS[org?.plan] || PLANS.free;
}

// Returns { projects, members } counts for an org.
export function orgUsage(db, orgId) {
  const projects = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE org_id = ?').get(orgId).n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?').get(orgId).n;
  return { projects, members };
}

// true if adding one more of `kind` would exceed the org's plan limit.
export function wouldExceed(db, org, kind) {
  const limit = planOf(org).limits[kind];
  if (limit == null) return false; // unlimited
  return orgUsage(db, org.id)[kind] >= limit;
}

// Create a checkout session. Real Stripe when a key is present, else a mock URL
// that the dev-activate endpoint / webhook stub can complete.
export async function createCheckout({ orgId, origin }) {
  const key = config.billing.stripeSecretKey;
  if (key) {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: config.billing.stripePriceId, quantity: 1 }],
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      client_reference_id: String(orgId),
      metadata: { orgId: String(orgId) },
    });
    return { url: session.url, live: true };
  }
  return { url: `${origin}/?billing=mock&org=${orgId}`, live: false, mock: true };
}
