import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { test, expect } from '@playwright/test';

import {
  counterbalancedBenchmarkRounds,
  stableBenchmarkChecksum,
  summarizeCounterbalancedMeasurements,
} from '../helpers/date-format-benchmark.mjs';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

const ITERATION_COUNT = 400_000;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 3;
const TARGET_IMPROVEMENT_PERCENT = 10;
const DEFAULT_BENCHMARK_BASE_REF = 'develop';

function assertImmutableSha(candidate, label) {
  const sha = String(candidate || '').trim();
  if (!/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) {
    throw new Error(`Missing immutable ${label} SHA: ${sha || '<missing>'}`);
  }
  return sha;
}

function assertBenchmarkBaseRef(candidate) {
  const baseRef = String(candidate || '').trim();
  if (!baseRef || baseRef.length > 255 || /[\u0000-\u001f\u007f]/u.test(baseRef)) {
    throw new Error(`Missing or invalid benchmark base ref: ${baseRef || '<missing>'}`);
  }
  return baseRef;
}

function githubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  return eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
}

function readOriginBranchTip(baseRef) {
  const branch = assertBenchmarkBaseRef(baseRef);
  const fullRef = `refs/heads/${branch}`;
  let output;
  try {
    output = execFileSync('git', ['ls-remote', '--heads', 'origin', fullRef], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Unable to resolve live benchmark base ${fullRef}`);
  }

  const matches = output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split(/\s+/u))
    .filter(([, remoteRef]) => remoteRef === fullRef);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one live benchmark base for ${fullRef}, found ${matches.length}`);
  }
  return assertImmutableSha(matches[0][0], `live benchmark base ${fullRef}`);
}

function readCurrentHeadSha() {
  let output;
  try {
    output = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Unable to resolve local benchmark contributor HEAD');
  }
  return assertImmutableSha(output, 'local benchmark contributor head');
}

function resolveBenchmarkBaseSha(event, readLiveBaseSha = readOriginBranchTip) {
  const override = String(process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA || '').trim();
  const pullRequestBase = event?.pull_request?.base;
  if (!pullRequestBase) {
    const eventBaseSha = String(event?.before || '').trim();
    if (override) {
      return assertImmutableSha(override, 'benchmark base');
    }
    if (eventBaseSha && !/^0{40}$/u.test(eventBaseSha)) {
      return assertImmutableSha(eventBaseSha, 'benchmark base');
    }
    const localBaseRef = assertBenchmarkBaseRef(
      process.env.SCOPEWEAVE_BENCHMARK_BASE_REF || DEFAULT_BENCHMARK_BASE_REF,
    );
    return assertImmutableSha(
      readLiveBaseSha(localBaseRef),
      `live benchmark base ${localBaseRef}`,
    );
  }

  const eventBaseSha = assertImmutableSha(pullRequestBase.sha, 'benchmark base');
  const baseRef = assertBenchmarkBaseRef(pullRequestBase.ref);
  const liveBaseSha = assertImmutableSha(
    readLiveBaseSha(baseRef),
    `live benchmark base ${baseRef}`,
  );
  if (liveBaseSha !== eventBaseSha) {
    throw new Error(
      `Protected base moved from ${eventBaseSha} to ${liveBaseSha}; regenerate benchmark against fresh ${baseRef}`,
    );
  }
  if (override) {
    const overrideSha = assertImmutableSha(override, 'benchmark base override');
    if (overrideSha !== liveBaseSha) {
      throw new Error(
        `Benchmark base override ${overrideSha} does not match live protected base ${liveBaseSha}`,
      );
    }
  }
  return liveBaseSha;
}

test('pull request benchmark refuses a stale protected-base event snapshot', () => {
  const originalOverride = process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
  delete process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
  try {
    const eventBaseSha = 'a'.repeat(40);
    const liveBaseSha = 'b'.repeat(40);
    const event = {
      pull_request: {
        base: { sha: eventBaseSha, ref: 'develop' },
      },
    };

    expect(() => resolveBenchmarkBaseSha(event, () => liveBaseSha)).toThrow(/protected base moved/i);
  } finally {
    if (originalOverride === undefined) {
      delete process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
    } else {
      process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA = originalOverride;
    }
  }
});

test('first-push zero before SHA falls back to the live protected base', () => {
  const originalOverride = process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
  const originalBaseRef = process.env.SCOPEWEAVE_BENCHMARK_BASE_REF;
  delete process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
  delete process.env.SCOPEWEAVE_BENCHMARK_BASE_REF;
  try {
    const liveBaseSha = 'c'.repeat(40);
    expect(resolveBenchmarkBaseSha({ before: '0'.repeat(40) }, (baseRef) => {
      expect(baseRef).toBe(DEFAULT_BENCHMARK_BASE_REF);
      return liveBaseSha;
    })).toBe(liveBaseSha);
  } finally {
    if (originalOverride === undefined) delete process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
    else process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA = originalOverride;
    if (originalBaseRef === undefined) delete process.env.SCOPEWEAVE_BENCHMARK_BASE_REF;
    else process.env.SCOPEWEAVE_BENCHMARK_BASE_REF = originalBaseRef;
  }
});

function resolveBenchmarkCandidateSha(event, readLocalHeadSha = readCurrentHeadSha) {
  const override = String(process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA || '').trim();
  if (override) return assertImmutableSha(override, 'benchmark contributor head');
  const eventCandidateSha = event?.pull_request?.head?.sha || event?.after || process.env.GITHUB_SHA;
  if (eventCandidateSha) {
    return assertImmutableSha(eventCandidateSha, 'benchmark contributor head');
  }
  return assertImmutableSha(readLocalHeadSha(), 'local benchmark contributor head');
}

test('documented cloud benchmark resolves local-clone revisions without a GitHub event', () => {
  const originalBaseOverride = process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
  const originalBaseRef = process.env.SCOPEWEAVE_BENCHMARK_BASE_REF;
  const originalHeadOverride = process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA;
  const originalGitHubSha = process.env.GITHUB_SHA;
  delete process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
  delete process.env.SCOPEWEAVE_BENCHMARK_BASE_REF;
  delete process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA;
  delete process.env.GITHUB_SHA;
  try {
    const liveBaseSha = 'c'.repeat(40);
    const localHeadSha = 'd'.repeat(40);
    expect(resolveBenchmarkBaseSha({}, (baseRef) => {
      expect(baseRef).toBe(DEFAULT_BENCHMARK_BASE_REF);
      return liveBaseSha;
    })).toBe(liveBaseSha);
    expect(resolveBenchmarkCandidateSha({}, () => localHeadSha)).toBe(localHeadSha);
  } finally {
    if (originalBaseOverride === undefined) delete process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA;
    else process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA = originalBaseOverride;
    if (originalBaseRef === undefined) delete process.env.SCOPEWEAVE_BENCHMARK_BASE_REF;
    else process.env.SCOPEWEAVE_BENCHMARK_BASE_REF = originalBaseRef;
    if (originalHeadOverride === undefined) delete process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA;
    else process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA = originalHeadOverride;
    if (originalGitHubSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = originalGitHubSha;
  }
});

function readGitFile(commitSha, path) {
  const spec = `${commitSha}:${path}`;
  try {
    return execFileSync('git', ['show', spec], { encoding: 'utf8' });
  } catch {
    execFileSync('git', ['fetch', '--depth=1', 'origin', commitSha], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return execFileSync('git', ['show', spec], { encoding: 'utf8' });
  }
}

function instrumentDateSource(source) {
  const bootstrapCall = '\nbootstrap();';
  const bootstrapIndex = source.lastIndexOf(bootstrapCall);
  if (bootstrapIndex === -1) {
    throw new Error('Benchmark app source is missing the expected bootstrap call');
  }

  const withoutBootstrap = `${source.slice(0, bootstrapIndex)}${source.slice(bootstrapIndex + bootstrapCall.length)}`;
  return `${withoutBootstrap}\n\nwindow.__scopeweaveDateBenchmark = Object.freeze({\n  formatDateInput,\n  formatLocalDateInput,\n  formatCompactDate,\n});\n`;
}

async function measureDateFormatting(browser, { appSource, label }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('**/app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: instrumentDateSource(appSource),
      });
    });

    await page.goto('/');
    const result = await page.evaluate(({ iterationCount, sampleCount, warmupCount }) => {
      const benchmark = window.__scopeweaveDateBenchmark;
      if (!benchmark) throw new Error('date-format benchmark bridge did not initialize');

      const dates = Array.from(
        { length: 366 },
        (_, index) => new Date(Date.UTC(2024, 0, index + 1, 12, 0, 0)),
      );

      const run = () => {
        let checksum = 0;
        for (let index = 0; index < iterationCount; index += 1) {
          const date = dates[index % dates.length];
          const utc = benchmark.formatDateInput(date);
          const local = benchmark.formatLocalDateInput(date);
          const compact = benchmark.formatCompactDate(date);
          checksum = (
            checksum
            + utc.charCodeAt(5)
            + utc.charCodeAt(8)
            + local.charCodeAt(5)
            + local.charCodeAt(8)
            + compact.charCodeAt(4)
            + compact.charCodeAt(7)
          ) >>> 0;
        }
        return checksum;
      };

      for (let warmup = 0; warmup < warmupCount; warmup += 1) {
        run();
      }

      const samples = [];
      const sampleChecksums = [];
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const startedAt = performance.now();
        sampleChecksums.push(run());
        samples.push(performance.now() - startedAt);
      }

      const semanticSnapshot = JSON.stringify(dates.map((date) => [
        benchmark.formatDateInput(date),
        benchmark.formatLocalDateInput(date),
        benchmark.formatCompactDate(date),
      ]));

      return { samples, sampleChecksums, semanticSnapshot };
    }, {
      iterationCount: ITERATION_COUNT,
      sampleCount: SAMPLE_COUNT,
      warmupCount: WARMUP_COUNT,
    });

    return {
      label,
      samples: result.samples,
      checksum: stableBenchmarkChecksum(result.sampleChecksums),
      semanticSnapshot: result.semanticSnapshot,
    };
  } finally {
    await context.close();
  }
}

test('@benchmark fixed-width date formatting preserves exact semantics and beats the protected base', async ({ browser }) => {
  test.setTimeout(240_000);

  const event = githubEvent();
  const baseSha = resolveBenchmarkBaseSha(event);
  const candidateSha = resolveBenchmarkCandidateSha(event);
  const sourceByLabel = new Map([
    ['protected-base', readGitFile(baseSha, 'app.js')],
    ['exact-contributor-head', readGitFile(candidateSha, 'app.js')],
  ]);
  const measurementOrder = counterbalancedBenchmarkRounds();
  const measurements = [];

  for (const round of measurementOrder) {
    for (const label of round) {
      measurements.push(await measureDateFormatting(browser, {
        appSource: sourceByLabel.get(label),
        label,
      }));
    }
  }

  for (const measurement of measurements) {
    expect(measurement.samples).toHaveLength(SAMPLE_COUNT);
    expect(measurement.samples.every((duration) => duration > 0)).toBe(true);
  }

  const summary = summarizeCounterbalancedMeasurements(measurements);
  expect(summary.baselineMedianDurationMs).toBeGreaterThan(0);
  expect(summary.candidateMedianDurationMs).toBeGreaterThan(0);
  expect(
    summary.improvementPercent,
    `expected >=${TARGET_IMPROVEMENT_PERCENT}% counterbalanced median date-format improvement for exact head ${candidateSha} over protected base ${baseSha}, got ${summary.improvementPercent.toFixed(2)}%`,
  ).toBeGreaterThanOrEqual(TARGET_IMPROVEMENT_PERCENT);

  const completionBaseSha = resolveBenchmarkBaseSha(event);
  expect(completionBaseSha).toBe(baseSha);

  console.log(`SCOPEWEAVE_DATE_FORMAT_BENCHMARK ${JSON.stringify({
    iterationCount: ITERATION_COUNT,
    sampleCountPerMeasurement: SAMPLE_COUNT,
    warmupCountPerMeasurement: WARMUP_COUNT,
    measurementOrder,
    protectedBaseSha: baseSha,
    exactContributorHeadSha: candidateSha,
    targetImprovementPercent: TARGET_IMPROVEMENT_PERCENT,
    improvementPercent: summary.improvementPercent,
    baseline: {
      samples: summary.baselineSamples,
      medianDurationMs: summary.baselineMedianDurationMs,
      checksum: summary.checksum,
    },
    optimized: {
      samples: summary.candidateSamples,
      medianDurationMs: summary.candidateMedianDurationMs,
      checksum: summary.checksum,
    },
  })}`);
});
