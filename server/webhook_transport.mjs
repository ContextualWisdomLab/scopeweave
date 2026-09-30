import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * POST a webhook by resolving the original hostname to one already-validated IP.
 *
 * The URL keeps its original hostname so HTTPS certificate validation and SNI
 * remain correct. Node's request API does not follow redirects.
 *
 * @param {URL} target Original webhook URL.
 * @param {string} address Validated IPv4 or IPv6 address.
 * @param {4 | 6} family Address family.
 * @param {{headers: Record<string, string>, body: string, signal?: AbortSignal}} options Request data.
 * @returns {Promise<{status: number, ok: boolean}>} Terminal HTTP response.
 */
export function postWebhook(target, address, family, { headers, body, signal } = {}) {
  const request = target.protocol === 'https:'
    ? httpsRequest
    : target.protocol === 'http:'
      ? httpRequest
      : null;
  if (!request) throw new TypeError('webhook URL must use http or https');

  return new Promise((resolve, reject) => {
    const req = request(target, {
      method: 'POST',
      headers,
      signal,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    }, (res) => {
      res.resume();
      res.once('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300 });
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}
