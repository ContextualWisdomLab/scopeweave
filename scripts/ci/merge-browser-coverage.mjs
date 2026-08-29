import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8ToIstanbul from 'v8-to-istanbul';
import coverageLib from 'istanbul-lib-coverage';

const { createCoverageMap } = coverageLib;

const root = fileURLToPath(new URL('../..', import.meta.url));
const nodeReportPath = path.join(root, 'coverage/node/coverage-final.json');
const browserDirectory = path.join(root, 'coverage/browser');
const outputDirectory = path.join(root, 'coverage');
const browserFiles = (await readdir(browserDirectory)).filter((file) => file.endsWith('.json'));
const coverageMap = createCoverageMap(JSON.parse(await readFile(nodeReportPath, 'utf8')));
const browserSources = new Map([
  ['/app.js', path.join(root, 'app.js')],
  ['/cloud-sync.js', path.join(root, 'cloud-sync.js')],
  ['/analytics.js', path.join(root, 'analytics.js')],
]);
let mergedEntries = 0;

for (const file of browserFiles) {
  const entries = JSON.parse(await readFile(path.join(browserDirectory, file), 'utf8'));
  for (const entry of entries) {
    const pathname = new URL(entry.url).pathname;
    const localPath = browserSources.get(pathname);
    if (!localPath || !entry.source) continue;

    const converter = v8ToIstanbul(localPath, 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    coverageMap.merge(createCoverageMap(converter.toIstanbul()));
    mergedEntries += 1;
  }
}

if (mergedEntries === 0) {
  throw new Error('No browser coverage entries were merged');
}

const summary = coverageMap.getCoverageSummary().toJSON();
await writeFile(path.join(outputDirectory, 'coverage-final.json'), JSON.stringify(coverageMap.toJSON(), null, 2));
await writeFile(path.join(outputDirectory, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ mergedEntries, summary }, null, 2));
