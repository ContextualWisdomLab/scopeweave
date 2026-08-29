/**
 * Transitional route import seam for the public security envelope.
 *
 * The supported shared application boundary is `application_routes.mjs`.
 * `server/app.mjs` imports this shim while temporarily disabling the historical
 * core limiter so the transport-peer-aware outer limiter is authoritative for
 * public traffic. Direct consumers should import `application_routes.mjs`, not
 * this compatibility seam.
 */
export { app } from './application_routes.mjs';
