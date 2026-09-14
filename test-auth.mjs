import { scryptSync } from 'node:crypto';
import { verifyPassword } from './server/auth.mjs';

const dummyHash = '00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

console.time('verify');
verifyPassword('candidate', dummyHash);
console.timeEnd('verify');

console.time('verify-fast');
verifyPassword('candidate', 'invalid');
console.timeEnd('verify-fast');
