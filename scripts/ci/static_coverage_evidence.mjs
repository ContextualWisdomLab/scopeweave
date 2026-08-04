#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const mode = process.argv[2];

function gitFiles(pathspec) {
  const repoRoot = resolve('.');
  return execFileSync(
    'git',
    ['-c', `safe.directory=${repoRoot}`, '-C', repoRoot, 'ls-files', pathspec],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

function checkDocstringScope() {
  const unsupported = gitFiles('*.py').filter(
    (file) => !file.startsWith('scripts/ci/') && !file.startsWith('tests/config/')
  );
  if (unsupported.length > 0) {
    console.error('Python docstring coverage is not configured for runtime Python files:');
    unsupported.forEach((file) => console.error(`- ${file}`));
    process.exit(1);
  }
  console.log('Python files are CI helpers or tests; runtime docstring coverage is not applicable.');
}

if (mode === 'docstrings') {
  checkDocstringScope();
} else {
  console.error('Usage: static_coverage_evidence.mjs docstrings');
  process.exit(2);
}
