import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { routeTokenPathSegment } from '../../cloud-sync.js';

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

const cloudSyncSource = await readFile(new URL('../../cloud-sync.js', import.meta.url), 'utf8');
const stylesheetSource = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');

assert.doesNotMatch(
  cloudSyncSource,
  /ssoBtn\.style\.(?:width|marginTop)\s*=/,
  'cloud SSO button layout must be owned by the stylesheet rather than inline JS styles',
);
assert.match(
  cloudSyncSource,
  /ssoBtn\.className\s*=\s*['"]secondary-button cloud-sso-button['"]/,
  'cloud SSO button must expose its dedicated stylesheet hook',
);
assert.match(
  stylesheetSource,
  /\.cloud-sso-button\s*\{[^}]*width:\s*100%;[^}]*margin-top:\s*8px;[^}]*\}/s,
  'cloud SSO button stylesheet must preserve the full-width and spacing behavior',
);
