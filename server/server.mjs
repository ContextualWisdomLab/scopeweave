import { serve } from '@hono/node-server';
import { app } from './app.mjs';

/**
 * Resolve the HTTP listener port from configuration.
 *
 * Port `0` is intentionally accepted so tests and operators can request an
 * ephemeral OS-assigned port. Missing, blank, whitespace-only, fractional,
 * negative, and out-of-range values fail closed to ScopeWeave's historical
 * default.
 *
 * @param {unknown} value - Raw `PORT` configuration value.
 * @returns {number} A valid TCP port in the inclusive range 0..65535.
 */
export function resolvePort(value) {
  const parsed = Number(value);
  if (
    (typeof value === 'string' && value.trim() === '')
    || !Number.isInteger(parsed)
    || parsed < 0
    || parsed > 65535
  ) {
    return 8787;
  }
  return parsed;
}

const port = resolvePort(process.env.PORT);
export const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScopeWeave API listening on http://localhost:${info.port}`);
});
