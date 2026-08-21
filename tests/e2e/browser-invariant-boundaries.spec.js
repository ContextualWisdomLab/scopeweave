import { readFileSync } from 'node:fs';
import { test, expect } from './coverage-test.js';

const APP_SOURCE = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const APP_BOOTSTRAP_LINE = APP_SOURCE
  .split(/\r?\n/)
  .findIndex((line) => line.trim() === 'bootstrap();');
const DEBUGGER_PAUSE_TIMEOUT_MS = 10_000;

if (APP_BOOTSTRAP_LINE < 0) {
  throw new Error('app.js bootstrap call was not found');
}

function waitForDebuggerBreakpoint(cdp, breakpointId) {
  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      cdp.off('Debugger.paused', onPaused);
    };

    const rejectAfterCleanup = (error) => {
      cleanup();
      reject(error);
    };

    const onPaused = (event) => {
      if (event.hitBreakpoints?.includes(breakpointId)) {
        cleanup();
        resolve(event);
        return;
      }

      cdp.send('Debugger.resume').catch((error) => {
        rejectAfterCleanup(new Error('Failed to resume an unrelated debugger pause', { cause: error }));
      });
    };

    timeoutId = setTimeout(() => {
      cleanup();
      cdp.send('Debugger.resume').catch(() => {}).finally(() => {
        reject(new Error('Timed out waiting for app.js bootstrap breakpoint'));
      });
    }, DEBUGGER_PAUSE_TIMEOUT_MS);

    cdp.on('Debugger.paused', onPaused);
  });
}

test.describe('browser invariant boundaries', () => {
  test('keeps defensive planner helpers deterministic without widening the browser API', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    let navigation;
    let paused = false;

    try {
      await cdp.send('Debugger.enable');
      const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', {
        urlRegex: '/app\\.js$',
        lineNumber: APP_BOOTSTRAP_LINE,
      });

      const pausedPromise = waitForDebuggerBreakpoint(cdp, breakpoint.breakpointId);
      navigation = page.goto('/');
      const pauseEvent = await pausedPromise;
      paused = true;

      const moduleFrame = pauseEvent.callFrames[0];
      expect(moduleFrame, 'app.js bootstrap breakpoint must expose a call frame').toBeTruthy();
      expect(moduleFrame.location.lineNumber).toBe(APP_BOOTSTRAP_LINE);

      const evaluation = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: moduleFrame.callFrameId,
        expression: String.raw`({
          zeroDurationProgress: calculatePlannedProgressRatio(
            '2026-08-20',
            '2026-08-19',
            '2026-08-21',
            0,
          ),
          missingDescendant: getLastDescendantId('missing-task-id'),
          malformedEndDate: getPlannedEndDateValue(null),
          escapedMarkup: escapeHtml('<script>"\'&</script>'),
          extensionTestId: toKebab('futureField_name'),
        })`,
        returnByValue: true,
      });
      expect(evaluation.exceptionDetails, 'private helper evaluation must not throw').toBeUndefined();

      const noHandleWrite = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: moduleFrame.callFrameId,
        expression: 'writeJsonSyncFile()',
        returnByValue: true,
        awaitPromise: true,
      });
      expect(noHandleWrite.exceptionDetails, 'no-handle sync path must not reject').toBeUndefined();
      expect(noHandleWrite.result.type).toBe('undefined');

      const result = evaluation.result.value;
      expect(result.zeroDurationProgress).toBe(1);
      expect(result.missingDescendant).toBe('missing-task-id');
      expect(result.malformedEndDate).toBe('');
      expect(result.escapedMarkup).toBe('&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;');
      expect(result.extensionTestId).toBe('future-field-name');
    } finally {
      if (paused) {
        await cdp.send('Debugger.resume').catch(() => {});
      }
      if (navigation) {
        await navigation.catch(() => {});
      }
      await cdp.detach().catch(() => {});
    }
  });
});
