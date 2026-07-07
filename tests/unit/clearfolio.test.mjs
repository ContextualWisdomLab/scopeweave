// Clearfolio 테넌트 클레임 HMAC — 서버 규격(TenantAccessService.signClaims)과 동형:
// payload = tenantId\nsubjectId\npermissions\nissuedAt → HMAC-SHA256 → base64url 무패딩.
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { signClaims } from '../../server/clearfolio.mjs';

const sig = signClaims('sw-org-1', 'sw-user-2', 'job:create,job:read', '1750000000', 's3cret');
const expect = createHmac('sha256', 's3cret')
  .update('sw-org-1\nsw-user-2\njob:create,job:read\n1750000000')
  .digest('base64url');
assert.equal(sig, expect, 'canonical payload joined with \\n');
assert.ok(!sig.includes('='), 'base64url without padding');
assert.notEqual(sig, signClaims('sw-org-1', 'sw-user-2', 'job:create,job:read', '1750000001', 's3cret'), 'issuedAt-sensitive');
assert.notEqual(sig, signClaims('sw-org-2', 'sw-user-2', 'job:create,job:read', '1750000000', 's3cret'), 'tenant-sensitive');

console.log('✓ clearfolio HMAC tests passed');
