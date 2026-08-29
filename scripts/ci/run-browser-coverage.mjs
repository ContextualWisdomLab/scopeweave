import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const coverageDirectory = path.join(root, 'coverage/browser');

await rm(coverageDirectory, { recursive: true, force: true });
await mkdir(coverageDirectory, { recursive: true });

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn('npm', ['run', 'test:e2e'], {
    cwd: root,
    env: { ...process.env, SCOPEWEAVE_BROWSER_COVERAGE: '1' },
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
