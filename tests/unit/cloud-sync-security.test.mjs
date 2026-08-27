import assert from 'node:assert/strict';

import { clearfolioCapabilityNotice, routeTokenPathSegment } from '../../cloud-sync.js';

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

assert.equal(clearfolioCapabilityNotice(null), '');
assert.equal(clearfolioCapabilityNotice({ ready: true, action: null }), '');
assert.equal(
  clearfolioCapabilityNotice({
    ready: false,
    action: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
  }),
  '문서 변환을 사용할 수 없습니다. Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
);
assert.equal(
  clearfolioCapabilityNotice({ ready: false, action: '   ' }),
  '문서 변환을 사용할 수 없습니다. 운영자에게 Clearfolio 설정을 요청하십시오.',
);
