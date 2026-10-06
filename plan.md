1. **Import `lookup` from `node:dns/promises` and `BlockList` from `node:net` in `server/app.mjs`.**
2. **Create a `BlockList` and function to validate outbound URLs.**
    *   Add loopback (127.0.0.1, ::1, 0.0.0.0, ::) and private IPs to the BlockList.
    *   Create an async function `isSafeUrl(url)` that resolves the host via `lookup` and checks the IPs against the blocklist.
3. **Update `sendWebhook` to validate `url` before calling `fetch()`.**
    *   Make `sendWebhook` async.
    *   Check `await isSafeUrl(url)`. If not safe, log a failure delivery and immediately return (do not retry, do not fetch).
    *   Add `redirect: 'error'` to the `fetch()` options to prevent redirects to internal addresses.
4. **Fix webhook delivery logging when blocked.**
    *   Call `recordDelivery(webhookId, event, null, false, attempt)` when rejected.
5. **Add tests to verify SSRF protection in `server/app.mjs`.**
6. **Pre-commit checks.**
7. **Submit PR.**
