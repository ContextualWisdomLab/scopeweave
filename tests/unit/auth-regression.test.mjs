import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';

test('auth regression: scryptSync is invoked exactly once per verification', () => {
    const authCode = fs.readFileSync('server/auth.mjs', 'utf8');
    // Strip imports since we'll provide them
    const codeWithoutImports = authCode.replace(/import .*? from '.*?';/g, '');

    let scryptCalls = 0;
    const mockCrypto = {
        scryptSync: (...args) => {
            scryptCalls++;
            return crypto.scryptSync(...args);
        },
        randomBytes: crypto.randomBytes,
        timingSafeEqual: crypto.timingSafeEqual,
        createHmac: crypto.createHmac,
        createHash: crypto.createHash
    };

    const context = vm.createContext({
        scryptSync: mockCrypto.scryptSync,
        randomBytes: mockCrypto.randomBytes,
        timingSafeEqual: mockCrypto.timingSafeEqual,
        createHmac: mockCrypto.createHmac,
        createHash: mockCrypto.createHash,
        Buffer: Buffer,
        process: { env: { SCOPEWEAVE_JWT_SECRET: '12345678901234567890123456789012' } },
        console,
        db: { prepare: () => ({ get: () => {} }) } // mock db
    });

    // Run the code, modifying export to put verifyPassword into context
    const script = new vm.Script(
        codeWithoutImports
            .replace(/export function verifyPassword/g, 'globalThis.verifyPassword = function verifyPassword')
            .replace(/export function/g, 'function')
            .replace(/export const/g, 'const')
    );
    script.runInContext(context);

    const verifyPassword = context.verifyPassword;

    // Helper to test a scenario
    const runScenario = (pwd, stored, expectedCalls, expectedResult) => {
        scryptCalls = 0;
        const result = verifyPassword(pwd, stored);
        assert.strictEqual(scryptCalls, expectedCalls, `Expected ${expectedCalls} scrypt calls, got ${scryptCalls}`);
        assert.strictEqual(result, expectedResult, `Expected result ${expectedResult}, got ${result}`);
    };

    const validSalt = '1234567890abcdef';
    const validDigest = crypto.scryptSync('ValidString123', validSalt, 64).toString('hex');
    const validStored = `${validSalt}:${validDigest}`;

    // 1. Existing + wrong password
    runScenario('WrongString456', validStored, 1, false);

    // 2. Missing user (dummy hash / undefined stored)
    runScenario('ValidString123', undefined, 1, false);

    // 3. Non-string password
    runScenario({ invalid: "type" }, validStored, 1, false);

    // 4. Valid string credential
    runScenario('ValidString123', validStored, 1, true);
});
