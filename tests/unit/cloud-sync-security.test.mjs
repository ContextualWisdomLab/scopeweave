import assert from 'node:assert/strict';

import { clearfolioCapabilityNotice, routeTokenPathSegment } from '../../cloud-sync.js';

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

assert.equal(
  clearfolioCapabilityNotice(null),
  '문서 변환 상태를 확인하지 못했습니다. 연결 또는 로그인 상태를 확인한 뒤 다시 시도하십시오. 업로드 시 서버가 최종 사용 가능 여부를 확인합니다.',
);
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
