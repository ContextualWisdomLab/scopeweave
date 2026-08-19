import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const { createCoverageMap } = coverageLibrary;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawRoot = path.join(repositoryRoot, '.coverage-browser');
const rawDirectory = path.join(rawRoot, 'raw');
const reportDirectory = path.join(repositoryRoot, 'coverage');
const expectedBrowserSources = ['app.js', 'cloud-sync.js'];

const normalizeBrowserPath = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
};

const uniqueSorted = (values) => [...new Set(values)].sort((left, right) => left - right);

const uncoveredLocations = (fileCoverage) => {
  const data = fileCoverage.data;
  const statements = Object.entries(data.s)
    .filter(([, hits]) => hits === 0)
    .map(([id]) => data.statementMap[id]?.start?.line)
    .filter(Number.isInteger);
  const functions = Object.entries(data.f)
    .filter(([, hits]) => hits === 0)
    .map(([id]) => data.fnMap[id]?.loc?.start?.line)
    .filter(Number.isInteger);
  const branches = Object.entries(data.b).flatMap(([id, hits]) =>
    hits.flatMap((count, index) => {
      if (count !== 0) return [];
      const line = data.branchMap[id]?.locations?.[index]?.start?.line;
      return Number.isInteger(line) ? [line] : [];
    }),
  );
  return {
    lines: fileCoverage.getUncoveredLines(),
    statements: uniqueSorted(statements),
    functions: uniqueSorted(functions),
    branches: uniqueSorted(branches),
  };
};

const metricSummary = (fileCoverage) => {
  const summary = fileCoverage.toSummary().data;
  return Object.fromEntries(
    ['statements', 'branches', 'functions', 'lines'].map((metric) => [metric, summary[metric]]),
  );
};

await rm(rawRoot, { recursive: true, force: true });
await mkdir(rawDirectory, { recursive: true });
await mkdir(reportDirectory, { recursive: true });

const playwrightCli = path.join(repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const testRun = spawnSync(process.execPath, [playwrightCli, 'test'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    SCOPEWEAVE_BROWSER_COVERAGE: '1',
    SCOPEWEAVE_BROWSER_COVERAGE_DIR: rawDirectory,
  },
  stdio: 'inherit',
});
if (testRun.error) throw testRun.error;
if (testRun.status !== 0) {
  process.exitCode = testRun.status ?? 1;
}

const rawFiles = (await readdir(rawDirectory)).filter((name) => name.endsWith('.json')).sort();
if (rawFiles.length === 0) {
  if (testRun.status !== 0) {
    console.error('Browser tests failed before any raw browser coverage evidence was emitted.');
  } else {
    throw new Error('Browser coverage produced no raw evidence files.');
  }
} else {
  const coverageMap = createCoverageMap({});
  const observedSources = new Set();
  for (const rawFile of rawFiles) {
    const payload = JSON.parse(await readFile(path.join(rawDirectory, rawFile), 'utf8'));
    if (!Array.isArray(payload.entries)) {
      throw new Error(`Malformed browser coverage evidence: ${rawFile}`);
    }
    for (const entry of payload.entries) {
      const browserPath = normalizeBrowserPath(entry.url);
      if (!expectedBrowserSources.includes(browserPath)) continue;
      observedSources.add(browserPath);
      const localPath = path.join(repositoryRoot, browserPath);
      const localBytes = await readFile(localPath);
      const localSource = localBytes.toString('utf8');
      const localSourceSha256 = createHash('sha256').update(localBytes).digest('hex');
      const servedSourceSha256 = payload.servedSourceSha256?.[`/${browserPath}`];
      if (typeof servedSourceSha256 !== 'string') {
        throw new Error(`Browser coverage lacks served-source identity for ${browserPath}.`);
      }
      if (servedSourceSha256 !== localSourceSha256) {
        throw new Error(`Browser served source does not match checked-out ${browserPath}.`);
      }
      if (!Array.isArray(entry.functions)) {
        throw new Error(`Browser coverage lacks V8 function ranges for ${browserPath}.`);
      }
      const converter = v8ToIstanbul(localPath, 0, { source: entry.source ?? localSource });
      await converter.load();
      converter.applyCoverage(entry.functions);
      coverageMap.merge(converter.toIstanbul());
    }
  }

  for (const expectedSource of expectedBrowserSources) {
    if (!observedSources.has(expectedSource)) {
      throw new Error(`Browser coverage never observed required production source ${expectedSource}.`);
    }
  }

  const report = {};
  let incomplete = false;
  for (const expectedSource of expectedBrowserSources) {
    const localPath = path.join(repositoryRoot, expectedSource);
    const fileCoverage = coverageMap.fileCoverageFor(localPath);
    const metrics = metricSummary(fileCoverage);
    const uncovered = uncoveredLocations(fileCoverage);
    report[expectedSource] = { metrics, uncovered };
    for (const metric of ['statements', 'branches', 'functions', 'lines']) {
      if (metrics[metric].pct !== 100) incomplete = true;
    }
  }

  await writeFile(
    path.join(reportDirectory, 'browser-coverage-final.json'),
    `${JSON.stringify(coverageMap.toJSON(), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(reportDirectory, 'browser-coverage-summary.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log('Browser production coverage:', JSON.stringify(report, null, 2));
  if (incomplete) {
    throw new Error('Browser production coverage is below 100% statement/branch/function/line coverage.');
  }
}
