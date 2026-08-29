import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const coveragePath = resolve(process.argv[2] || 'coverage/coverage-final.json');

const locationText = (location) => {
  const start = location?.start ?? {};
  const end = location?.end ?? start;
  const startLine = Number.isInteger(start.line) ? start.line : '?';
  const startColumn = Number.isInteger(start.column) ? start.column + 1 : '?';
  const endLine = Number.isInteger(end.line) ? end.line : startLine;
  const endColumn = Number.isInteger(end.column) ? end.column + 1 : startColumn;
  return `${startLine}:${startColumn}-${endLine}:${endColumn}`;
};

let coverage;
try {
  coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
} catch (error) {
  console.error(`coverage diagnostics unavailable: ${coveragePath}: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const misses = [];
for (const [filePath, fileCoverage] of Object.entries(coverage)) {
  for (const [statementId, count] of Object.entries(fileCoverage.s ?? {})) {
    if (count !== 0) continue;
    misses.push({
      kind: 'statement',
      filePath,
      id: statementId,
      location: fileCoverage.statementMap?.[statementId],
    });
  }

  for (const [functionId, count] of Object.entries(fileCoverage.f ?? {})) {
    if (count !== 0) continue;
    const definition = fileCoverage.fnMap?.[functionId];
    misses.push({
      kind: `function:${definition?.name || '(anonymous)'}`,
      filePath,
      id: functionId,
      location: definition?.decl ?? definition?.loc,
    });
  }

  for (const [branchId, counts] of Object.entries(fileCoverage.b ?? {})) {
    const definition = fileCoverage.branchMap?.[branchId];
    counts.forEach((count, armIndex) => {
      if (count !== 0) return;
      misses.push({
        kind: `branch:${definition?.type || 'unknown'}[${armIndex}]`,
        filePath,
        id: branchId,
        location: definition?.locations?.[armIndex] ?? definition?.loc,
      });
    });
  }
}

if (misses.length === 0) {
  console.log('coverage diagnostics: no uncovered Istanbul statements, functions, or branch arms');
} else {
  console.error(`coverage diagnostics: ${misses.length} uncovered Istanbul entries`);
  for (const miss of misses) {
    console.error(`COVERAGE_MISS ${miss.kind} ${miss.filePath}:${locationText(miss.location)} id=${miss.id}`);
  }
}
