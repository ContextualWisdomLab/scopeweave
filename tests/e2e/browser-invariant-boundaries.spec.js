import { test, expect } from './coverage-test.js';

const APP_BOOTSTRAP_LINE = 2728;
const DEBUGGER_PAUSE_TIMEOUT_MS = 10_000;

function waitForDebuggerPause(cdp) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timed out waiting for app.js module breakpoint'));
    }, DEBUGGER_PAUSE_TIMEOUT_MS);

    cdp.once('Debugger.paused', (event) => {
      clearTimeout(timeoutId);
      resolve(event);
    });
  });
}

test.describe('browser invariant boundaries', () => {
  test('keeps defensive planner helpers deterministic without widening the browser API', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    let navigation;
    let paused = false;

    try {
      await cdp.send('Debugger.enable');
      await cdp.send('Debugger.setBreakpointByUrl', {
        urlRegex: '/app\\.js$',
        lineNumber: APP_BOOTSTRAP_LINE,
      });

      const pausedPromise = waitForDebuggerPause(cdp);
      navigation = page.goto('/');
      const pauseEvent = await pausedPromise;
      paused = true;

      const moduleFrame = pauseEvent.callFrames.find(({ url }) => /\/app\.js$/.test(url));
      expect(moduleFrame, 'app.js module frame must be paused at bootstrap').toBeTruthy();

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
