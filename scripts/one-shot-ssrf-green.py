from pathlib import Path


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "server/app.mjs",
    "import { computeEvm } from '../analytics.js'; // pure math, shared with the client\n",
    "import { computeEvm } from '../analytics.js'; // pure math, shared with the client\n"
    "import { postWebhook, validateWebhookUrl } from './webhook_delivery.mjs';\n",
)

replace_once(
    "server/app.mjs",
    """function sendWebhook(webhookId, url, sig, event, body, attempt) {
  metrics.webhookDeliveries++;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 3000);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scopeweave-event': event, 'x-scopeweave-signature': `sha256=${sig}` },
    body,
    signal: ctrl.signal,
  }).then((res) => {
    recordDelivery(webhookId, event, res.status, res.ok, attempt);
    if (!res.ok && attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).catch(() => {
    recordDelivery(webhookId, event, null, false, attempt);
    if (attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).finally(() => clearTimeout(to));
}
""",
    """function sendWebhook(webhookId, url, sig, event, body, attempt) {
  metrics.webhookDeliveries++;
  postWebhook(url, {
    headers: { 'content-type': 'application/json', 'x-scopeweave-event': event, 'x-scopeweave-signature': `sha256=${sig}` },
    body,
    timeoutMs: 3000,
  }).then((res) => {
    recordDelivery(webhookId, event, res.status, res.ok, attempt);
    if (!res.ok && attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).catch(() => {
    recordDelivery(webhookId, event, null, false, attempt);
    if (attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  });
}
""",
)

replace_once(
    "server/app.mjs",
    """function isInternalUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host === '[0:0:0:0:0:0:0:1]') return true;
    if (host.startsWith('127.') || host.startsWith('169.254.') || host.startsWith('192.168.')) return true;
    if (host.startsWith('10.') && /^\\d+\\.\\d+\\.\\d+$/.test(host.substring(3))) return true;
    if (/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(host)) return true;
    return false;
  } catch { return true; }
}

""",
    "",
)

replace_once(
    "server/app.mjs",
    """  const { url, events } = await c.req.json().catch(() => ({}));
  if (!/^https?:\\/\\//.test(String(url || ''))) return c.json({ error: 'valid http(s) url required' }, 400);
  if (isInternalUrl(url)) return c.json({ error: 'internal urls are not allowed' }, 400);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
""",
    """  const { url, events } = await c.req.json().catch(() => ({}));
  let webhookUrl;
  try {
    webhookUrl = validateWebhookUrl(url).toString();
  } catch {
    return c.json({ error: 'valid public https url required' }, 400);
  }
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
""",
)

replace_once(
    "server/app.mjs",
    """  const id = rowid(db.prepare('INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)').run(orgId, url, secret, evs));
  logAudit(orgId, uid, 'webhook.create', 'webhook', id, { url, events: evs });
  return c.json({ id, url, events: evs, secret }); // secret shown once for signature verification
""",
    """  const id = rowid(db.prepare('INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)').run(orgId, webhookUrl, secret, evs));
  logAudit(orgId, uid, 'webhook.create', 'webhook', id, { url: webhookUrl, events: evs });
  return c.json({ id, url: webhookUrl, events: evs, secret }); // secret shown once for signature verification
""",
)

replace_once(
    "tests/api/smoke.mjs",
    "  r = await req(`/api/orgs/${orgAId}/webhooks`, { method: 'POST', headers: auth, body: body({ url: 'http://example.com/hook', events: ['project.update'] }) });",
    "r = await req(`/api/orgs/${orgAId}/webhooks`, { method: 'POST', headers: auth, body: body({ url: 'https://192.168.example.com/hook', events: ['never'] }) });",
)

replace_once(
    "tests/api/smoke.mjs",
    """// trigger project.update → a delivery is attempted (counter increments synchronously)
const before = (await (await req('/api/metrics')).json()).webhookDeliveries;
r = await req(`/api/projects/${proj.id}`, { headers: auth });
const pv2 = (await r.json()).version;
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'wh', name: '훅' }], version: pv2 }) });
assert.equal(r.status, 200);
const after = (await (await req('/api/metrics')).json()).webhookDeliveries;
assert.ok(after > before, 'webhook delivery attempted on project.update');
// outcome recorded: refused url → ok=0, retried to attempt 2
await new Promise((res) => setTimeout(res, 900));
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}/deliveries`, { headers: auth });
assert.equal(r.status, 200, 'deliveries endpoint');
const dels = (await r.json()).deliveries;
assert.ok(dels.length >= 2, 'delivery attempts recorded');
assert.ok(dels.every((d) => d.ok === 0), 'refused url recorded as failed');
assert.ok(dels.some((d) => d.attempt === 2), 'failed delivery retried (attempt 2)');
""",
    """// This subscription is deliberately unused; deterministic network/retry behavior is
// covered by webhook-ssrf.test.mjs without relying on public DNS or Internet timing.
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}/deliveries`, { headers: auth });
assert.equal(r.status, 200, 'deliveries endpoint');
assert.deepEqual((await r.json()).deliveries, [], 'unused webhook has no deliveries');
""",
)

replace_once(
    "tests/unit/webhook-delivery.test.mjs",
    "const zeroStatusTransport = fakeRequestFactory(undefined);",
    "const zeroStatusTransport = fakeRequestFactory(null);",
)

replace_once(
    ".jules/sentinel.md",
    """## 2026-09-01 - Prevent SSRF via webhook URLs
**Vulnerability:** The `/api/orgs/:id/webhooks` POST endpoint accepted any valid HTTP/HTTPS URL, including internal IP addresses and loopback domains (`127.0.0.1`, `localhost`, etc). This allowed Server-Side Request Forgery (SSRF).
**Learning:** `new URL(urlStr).hostname` should be strictly validated against a blocklist of internal IP ranges and loopback domains before issuing external HTTP requests on behalf of a user. The native `URL` constructor handles various IP format normalizations effectively.
**Prevention:** Always validate webhook URLs against a known blocklist of internal and loopback IP addresses (like `127.x.x.x`, `10.x.x.x`, `169.254.x.x`, `localhost`) to prevent SSRF vulnerabilities.""",
    """## 2026-09-01 - Prevent SSRF via webhook destinations
**Vulnerability:** Webhook registration accepted plaintext HTTP and trusted hostname text before delivery. A DNS name, redirect, IPv6 literal, or legacy persisted row could therefore reach a loopback, private, link-local, metadata, or other special-purpose destination after the registration check.
**Learning:** Registration-time hostname blocklists are not a network security boundary. OWASP SSRF guidance requires redirect controls, and RFC 6890/IANA special-purpose registries define address semantics. Node's OS-backed DNS lookup must be bound directly to the outbound socket so there is no second unvalidated resolution between policy and connection.
**Prevention:** Accept HTTPS-only webhook URLs without embedded credentials; distinguish IP literals from DNS labels; validate all DNS answers against standards-derived special-purpose ranges at every delivery attempt; give the validated lookup directly to a non-pooled HTTPS request; never follow redirects; and revalidate legacy persisted webhook rows. Tests use deterministic DNS/transport seams plus a real loopback listener to prove zero internal network access.
**References:** OWASP Foundation, *Server Side Request Forgery Prevention Cheat Sheet* (2026); IANA, *IPv4/IPv6 Special-Purpose Address Registries* (2026); Cotton et al., RFC 6890 (2013); OpenJS Foundation, Node.js DNS and HTTPS API documentation (2026).""",
)

replace_once(
    "docs/api.md",
    """Events: `project.update`, `project.delete`, `member.join`, `billing.upgrade`
(subscribe with `*` for all). Deliveries retry **once** on failure and each
attempt is recorded.
""",
    """Events: `project.update`, `project.delete`, `member.join`, `billing.upgrade`
(subscribe with `*` for all). Destinations must use public HTTPS endpoints without
embedded credentials. Every delivery attempt revalidates DNS at the socket boundary,
does not follow redirects, retries **once** on failure, and records each attempt.
""",
)
replace_once(
    "docs/api.md",
    "| `POST` | `/api/orgs/:id/webhooks` | `{ url, events? }` → `whsec_` secret shown **once** (manage) |",
    "| `POST` | `/api/orgs/:id/webhooks` | `{ url, events? }` where `url` is public HTTPS → `whsec_` secret shown **once** (manage) |",
)

replace_once(
    "docs/product-technical-gap-baseline.md",
    "| Current reviewers identified DNS rebinding/resolution, IPv6, redirects, plaintext HTTP, public numeric-looking hostname false positives, and nondeterministic external-network smoke tests. | OPEN until GREEN | Every delivery attempt re-resolves through the operating-system resolver at the socket boundary, rejects any non-public answer, pins the connection to validated answers, disables redirect following, preserves TLS verification, and uses deterministic network seams in tests. |",
    "| Current reviewers identified DNS rebinding/resolution, IPv6, redirects, plaintext HTTP, public numeric-looking hostname false positives, and nondeterministic external-network smoke tests. | GREEN implemented; exact-head gates pending | `server/webhook_delivery.mjs` owns the outbound adapter: every attempt re-resolves through the operating-system resolver at the socket boundary, rejects any non-public answer, pins the connection to validated answers, disables redirect following, preserves TLS verification, and exposes deterministic test seams. |",
)
