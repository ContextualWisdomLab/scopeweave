import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { test, expect } from '@playwright/test';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

const ITERATION_COUNT = 400_000;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 3;
const TARGET_IMPROVEMENT_PERCENT = 10;

function assertImmutableSha(candidate, label) {
  const sha = String(candidate || '').trim();
  if (!/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) {
    throw new Error(`Missing immutable ${label} SHA: ${sha || '<missing>'}`);
  }
  return sha;
}

function githubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  return eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
}

function resolveBenchmarkBaseSha(event) {
  const override = String(process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA || '').trim();
  if (override) return assertImmutableSha(override, 'benchmark base');
  return assertImmutableSha(
    event?.pull_request?.base?.sha || event?.before || '',
    'benchmark base',
  );
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

function resolveBenchmarkCandidateSha(event) {
  const override = String(process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA || '').trim();
  if (override) return assertImmutableSha(override, 'benchmark contributor head');
  return assertImmutableSha(
    event?.pull_request?.head?.sha || event?.after || process.env.GITHUB_SHA || '',
    'benchmark contributor head',
  );
}

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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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
      let checksum = 0;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const startedAt = performance.now();
        checksum ^= run();
        samples.push(performance.now() - startedAt);
      }

      const semanticSnapshot = JSON.stringify(dates.map((date) => [
        benchmark.formatDateInput(date),
        benchmark.formatLocalDateInput(date),
        benchmark.formatCompactDate(date),
      ]));

      return { samples, checksum, semanticSnapshot };
    }, {
      iterationCount: ITERATION_COUNT,
      sampleCount: SAMPLE_COUNT,
      warmupCount: WARMUP_COUNT,
    });

    return {
      label,
      ...result,
      medianDurationMs: median(result.samples),
    };
  } finally {
    await context.close();
  }
}

test('fixed-width date formatting preserves exact semantics and beats the protected base', async ({ browser }) => {
  test.setTimeout(120_000);

  const event = githubEvent();
  const baseSha = resolveBenchmarkBaseSha(event);
  const candidateSha = resolveBenchmarkCandidateSha(event);
  const baselineSource = readGitFile(baseSha, 'app.js');
  const candidateSource = readGitFile(candidateSha, 'app.js');
  const baseline = await measureDateFormatting(browser, {
    appSource: baselineSource,
    label: 'protected-base',
  });
  const optimized = await measureDateFormatting(browser, {
    appSource: candidateSource,
    label: 'exact-contributor-head',
  });

  expect(optimized.samples).toHaveLength(SAMPLE_COUNT);
  expect(baseline.samples).toHaveLength(SAMPLE_COUNT);
  expect(optimized.medianDurationMs).toBeGreaterThan(0);
  expect(baseline.medianDurationMs).toBeGreaterThan(0);
  expect(optimized.semanticSnapshot).toBe(baseline.semanticSnapshot);
  expect(optimized.checksum).toBe(baseline.checksum);

  const improvementPercent = (
    (baseline.medianDurationMs - optimized.medianDurationMs)
    / baseline.medianDurationMs
  ) * 100;

  expect(
    improvementPercent,
    `expected >=${TARGET_IMPROVEMENT_PERCENT}% median date-format improvement for exact head ${candidateSha} over protected base ${baseSha}, got ${improvementPercent.toFixed(2)}%`,
  ).toBeGreaterThanOrEqual(TARGET_IMPROVEMENT_PERCENT);

  console.log(`SCOPEWEAVE_DATE_FORMAT_BENCHMARK ${JSON.stringify({
    iterationCount: ITERATION_COUNT,
    sampleCount: SAMPLE_COUNT,
    warmupCount: WARMUP_COUNT,
    protectedBaseSha: baseSha,
    exactContributorHeadSha: candidateSha,
    targetImprovementPercent: TARGET_IMPROVEMENT_PERCENT,
    improvementPercent,
    baseline: {
      samples: baseline.samples,
      medianDurationMs: baseline.medianDurationMs,
      checksum: baseline.checksum,
    },
    optimized: {
      samples: optimized.samples,
      medianDurationMs: optimized.medianDurationMs,
      checksum: optimized.checksum,
    },
  })}`);
});
