import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { app } from './app.mjs';

export const runtimeApp = new Hono();

// Apply security headers to all routes
runtimeApp.use('*', secureHeaders());

// Mount the canonical application
runtimeApp.route('/', app);
