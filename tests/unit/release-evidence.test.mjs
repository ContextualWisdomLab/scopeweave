import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EVIDENCE_FILES,
  DEFAULT_REQUIRED_DOCUMENTS,
  collectReleaseEvidence,
  normalizeSourceRevision,
  sha256Hex,
} from '../../server/release_evidence.mjs';

const REVISION = '1234567890abcdef1234567890abcdef12345678';

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scopeweave-release-evidence-'));
  try {
    for (const relativePath of DEFAULT_EVIDENCE_FILES) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      const content = relativePath === 'package.json'
        ? JSON.stringify({ name: 'scopeweave', version: '1.0.0', dependencies: { hono: '^4.13.0' }, devDependencies: { c8: '12.0.0' } })
        : relativePath === 'package-lock.json'
          ? JSON.stringify({ packages: { '': { name: 'scopeweave', version: '1.0.0', dependencies: { hono: '^4.13.0' }, devDependencies: { c8: '12.0.0' } } } })
          : `${relativePath}\n`;
      await writeFile(absolutePath, content);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

assert.equal(sha256Hex(Buffer.from('ScopeWeave')), '945fd588dc89f3b6addfb00e52b5f76016a8b45af34797a203af0c8bfc01a63f');
assert.equal(normalizeSourceRevision(`  ${REVISION.toUpperCase()}  `), REVISION);
for (const invalid of [null, '', 'abc', '0'.repeat(40), 'g'.repeat(40)]) {
  assert.throws(() => normalizeSourceRevision(invalid), TypeError);
}

await withFixture(async (root) => {
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.equal(report.ready, true);
  assert.equal(report.packageLockConsistent, true);
  assert.equal(report.workingTreeClean, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.fileEvidence.map(({ path: evidencePath }) => evidencePath), [...DEFAULT_EVIDENCE_FILES].sort((a, b) => a.localeCompare(b)));
  assert.ok(report.fileEvidence.every((entry) => entry.status === 'present' && /^[0-9a-f]{64}$/.test(entry.sha256)));
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.fileEvidence), true);
  assert.equal(Object.isFrozen(report.fileEvidence[0]), true);
});

await withFixture(async (root) => {
  await rm(path.join(root, 'PRD.md'));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION, workingTreeClean: false });
  assert.equal(report.ready, false);
  assert.deepEqual(report.issues.map(({ code }) => code), ['dirty_worktree', 'missing_evidence']);
  assert.match(report.issues.find(({ code }) => code === 'missing_evidence').action, /PRD\.md/);
});

await withFixture(async (root) => {
  const target = path.join(root, 'real-security.md');
  await writeFile(target, 'external-ish target');
  await rm(path.join(root, 'SECURITY.md'));
  await symlink(target, path.join(root, 'SECURITY.md'));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.equal(report.ready, false);
  assert.equal(report.issues.find(({ path: issuePath }) => issuePath === 'SECURITY.md').code, 'symlink_evidence');
});

await withFixture(async (root) => {
  await rm(path.join(root, 'TRD.md'));
  await mkdir(path.join(root, 'TRD.md'));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.equal(report.issues.find(({ path: issuePath }) => issuePath === 'TRD.md').code, 'non_file_evidence');
});

await withFixture(async (root) => {
  await writeFile(path.join(root, 'README.md'), '0123456789');
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION, maxFileBytes: 4 });
  assert.equal(report.ready, false);
  assert.equal(report.issues.find(({ path: issuePath }) => issuePath === 'README.md').code, 'oversized_evidence');
});

await withFixture(async (root) => {
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { name: 'scopeweave', version: '2.0.0' } } }));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.equal(report.packageLockConsistent, false);
  assert.equal(report.issues.find(({ code }) => code === 'package_lock_mismatch').path, 'package-lock.json');
});

await withFixture(async (root) => {
  await writeFile(path.join(root, 'package-lock.json'), '{');
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /not valid JSON/);
});

await withFixture(async (root) => {
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /no root package record/);
});

await withFixture(async (root) => {
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({}));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /no root package record/);
});

await withFixture(async (root) => {
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  await writeFile(packagePath, JSON.stringify({ name: 'other', version: '1.0.0' }));
  await writeFile(lockPath, JSON.stringify({ packages: { '': { name: 'scopeweave', version: '1.0.0' } } }));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /name\/version/);
});

await withFixture(async (root) => {
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  await writeFile(packagePath, JSON.stringify({ name: 'scopeweave', version: '1.0.0' }));
  await writeFile(lockPath, JSON.stringify({ packages: { '': { name: 'scopeweave', version: '1.0.0' } } }));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.equal(report.packageLockConsistent, true);
});

await withFixture(async (root) => {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(packagePath, 'utf8'));
  packageJson.dependencies.extra = '1.0.0';
  await writeFile(packagePath, JSON.stringify(packageJson));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /runtime dependency/);
});

await withFixture(async (root) => {
  const report = await collectReleaseEvidence({
    repositoryRoot: root,
    sourceRevision: REVISION,
    requiredDocuments: ['README.md'],
    evidenceFiles: ['README.md'],
  });
  assert.equal(report.packageLockConsistent, false);
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /both required/);
});

await withFixture(async (root) => {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(packagePath, 'utf8'));
  packageJson.dependencies.hono = '^4.14.0';
  await writeFile(packagePath, JSON.stringify(packageJson));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /runtime dependency/);
});

await withFixture(async (root) => {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(packagePath, 'utf8'));
  packageJson.devDependencies.c8 = '13.0.0';
  await writeFile(packagePath, JSON.stringify(packageJson));
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /development dependency/);
});

await withFixture(async (root) => {
  const report = await collectReleaseEvidence({
    repositoryRoot: root,
    sourceRevision: REVISION,
    requiredDocuments: ['README.md', 'README.md'],
    evidenceFiles: ['Dockerfile.server', 'README.md', 'Dockerfile.server'],
  });
  assert.deepEqual(report.fileEvidence.map(({ path: evidencePath }) => evidencePath), ['Dockerfile.server', 'README.md']);
});

await withFixture(async (root) => {
  const missingOptional = await collectReleaseEvidence({
    repositoryRoot: root,
    sourceRevision: REVISION,
    requiredDocuments: ['README.md'],
    evidenceFiles: ['README.md', 'optional.txt', 'package.json', 'package-lock.json'],
  });
  const issue = missingOptional.issues.find(({ path: issuePath }) => issuePath === 'optional.txt');
  assert.equal(issue.severity, 'warning');
  assert.equal(missingOptional.ready, true);
});

await withFixture(async (root) => {
  const racedFs = {
    async lstat(filePath) {
      const stats = await (await import('node:fs/promises')).lstat(filePath);
      return { isSymbolicLink: () => false, isDirectory: () => stats.isDirectory(), isFile: () => stats.isFile(), size: 1 };
    },
    async readFile(filePath) {
      if (filePath.endsWith('README.md')) return Buffer.from('grown after stat');
      return (await import('node:fs/promises')).readFile(filePath);
    },
  };
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION, maxFileBytes: 4, fsApi: racedFs });
  assert.equal(report.issues.find(({ path: issuePath }) => issuePath === 'README.md').code, 'oversized_evidence');
});

await withFixture(async (root) => {
  await rm(path.join(root, 'docs'), { recursive: true, force: true });
  await writeFile(path.join(root, 'docs'), 'not a directory');
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.equal(report.issues.find(({ path: issuePath }) => issuePath === 'docs/OPERABILITY.md').code, 'non_file_evidence');
});

await withFixture(async (root) => {
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'scopeweave-release-evidence-external-'));
  try {
    await rm(path.join(root, 'docs'), { recursive: true, force: true });
    await symlink(externalDir, path.join(root, 'docs'));
    const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
    assert.equal(report.issues.find(({ path: issuePath }) => issuePath === 'docs/OPERABILITY.md').code, 'symlink_evidence');
  } finally {
    await rm(externalDir, { recursive: true, force: true });
  }
});

await withFixture(async (root) => {
  await writeFile(path.join(root, 'package-lock.json'), 'null');
  const report = await collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /no root package record/);
});

await withFixture(async (root) => {
  const report = await collectReleaseEvidence({
    repositoryRoot: root,
    sourceRevision: REVISION,
    requiredDocuments: ['README.md'],
    evidenceFiles: ['README.md', 'package.json'],
  });
  assert.match(report.issues.find(({ code }) => code === 'package_lock_mismatch').action, /both required/);
});

await withFixture(async (root) => {
  const nullErrorFs = {
    async lstat(filePath) {
      if (filePath.endsWith('README.md')) throw null;
      return (await import('node:fs/promises')).lstat(filePath);
    },
    readFile: (filePath) => import('node:fs/promises').then((fs) => fs.readFile(filePath)),
  };
  await assert.rejects(() => collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION, fsApi: nullErrorFs }), (error) => error === null);
});

await withFixture(async (root) => {
  const deniedFs = {
    async lstat(filePath) {
      if (filePath.endsWith('README.md')) {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      }
      return (await import('node:fs/promises')).lstat(filePath);
    },
    readFile: (filePath) => import('node:fs/promises').then((fs) => fs.readFile(filePath)),
  };
  await assert.rejects(() => collectReleaseEvidence({ repositoryRoot: root, sourceRevision: REVISION, fsApi: deniedFs }), /denied/);
});

await assert.rejects(() => collectReleaseEvidence(), TypeError);

for (const args of [
  {},
  { repositoryRoot: '   ', sourceRevision: REVISION },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, maxFileBytes: 0 },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, maxFileBytes: 1.5 },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, fsApi: {} },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, fsApi: null },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, fsApi: { lstat() {} } },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, requiredDocuments: [null] },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, requiredDocuments: ['   '] },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, requiredDocuments: ['/absolute'] },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, requiredDocuments: ['../secret'] },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, requiredDocuments: ['./README.md'] },
  { repositoryRoot: '/tmp', sourceRevision: REVISION, requiredDocuments: ['C:/secret'] },
]) {
  await assert.rejects(() => collectReleaseEvidence(args), TypeError);
}

console.log('release evidence manifest regression passed');
