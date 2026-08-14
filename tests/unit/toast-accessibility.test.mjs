import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const toast = html.match(/<div\b[^>]*\bid="toast"[^>]*>/)?.[0];

assert.ok(toast, 'the toast container is present in the production document');
assert.match(toast, /\brole="status"/, 'toast updates are exposed as a status live region');
assert.match(toast, /\baria-live="polite"/, 'status announcements remain polite');
assert.match(toast, /\baria-atomic="true"/, 'assistive technology is asked to announce the whole status message');
assert.doesNotMatch(toast, /\btabindex=/, 'status updates do not move keyboard focus');

console.log('✓ toast accessibility markup contract passed');
