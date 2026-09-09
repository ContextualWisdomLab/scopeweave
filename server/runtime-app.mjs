import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { app as baseApp } from './app.mjs';

export const app = new Hono();
app.use('*', secureHeaders());
app.route('/', baseApp);
