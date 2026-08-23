/**
 * Public ScopeWeave HTTP application.
 *
 * `application_routes.mjs` is the single supported shared route boundary, so
 * public serving and direct route-graph consumers enforce the same security
 * controls instead of maintaining separate wrapper logic.
 */
export { app } from './application_routes.mjs';
