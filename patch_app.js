import fs from 'fs';

const content = fs.readFileSync('server/app.mjs', 'utf8');

let newContent = content.replace(
  "import { computeEvm } from '../analytics.js'; // pure math, shared with the client",
  "import { computeEvm } from '../analytics.js'; // pure math, shared with the client\nimport { postWebhookOnce, parseWebhookUrl } from './webhook_transport.mjs';"
);

newContent = newContent.replace(
  `function sendWebhook(webhookId, url, sig, event, body, attempt) {
  metrics.webhookDeliveries++;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 3000);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scopeweave-event': event, 'x-scopeweave-signature': \`sha256=\${sig}\` },
    body,
    signal: ctrl.signal,
  }).then((res) => {
    recordDelivery(webhookId, event, res.status, res.ok, attempt);
    if (!res.ok && attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).catch(() => {
    recordDelivery(webhookId, event, null, false, attempt);
    if (attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).finally(() => clearTimeout(to));
}`,
  `function sendWebhook(webhookId, url, sig, event, body, attempt) {
  metrics.webhookDeliveries++;
  postWebhookOnce({
    url,
    headers: { 'content-type': 'application/json', 'x-scopeweave-event': event, 'x-scopeweave-signature': \`sha256=\${sig}\` },
    body,
  }).then((res) => {
    recordDelivery(webhookId, event, res.status, res.ok, attempt);
    if (!res.ok && attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).catch(() => {
    recordDelivery(webhookId, event, null, false, attempt);
    if (attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  });
}`
);

newContent = newContent.replace(
  `function isInternalUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host === '[0:0:0:0:0:0:0:1]') return true;
    if (host.startsWith('127.') || host.startsWith('169.254.') || host.startsWith('192.168.')) return true;
    if (host.startsWith('10.') && /^\\d+\\.\\d+\\.\\d+$/.test(host.substring(3))) return true;
    if (/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(host)) return true;
    return false;
  } catch { return true; }
}`,
  ``
);

newContent = newContent.replace(
  `app.post('/api/orgs/:id/webhooks', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const { url, events } = await c.req.json().catch(() => ({}));
  if (!/^https?:\\/\\//.test(String(url || ''))) return c.json({ error: 'valid http(s) url required' }, 400);
  if (isInternalUrl(url)) return c.json({ error: 'internal urls are not allowed' }, 400);
  const secret = \`whsec_\${randomBytes(24).toString('base64url')}\`;
  const evs = Array.isArray(events) ? events.join(',') : (events || '*');
  const id = rowid(db.prepare('INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)').run(orgId, url, secret, evs));
  logAudit(orgId, uid, 'webhook.create', 'webhook', id, { url, events: evs });
  return c.json({ id, url, events: evs, secret }); // secret shown once for signature verification
});`,
  `app.post('/api/orgs/:id/webhooks', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const { url, events } = await c.req.json().catch(() => ({}));
  let webhookUrl;
  try {
    webhookUrl = parseWebhookUrl(url).toString();
  } catch {
    return c.json({ error: 'valid public https url required' }, 400);
  }
  const secret = \`whsec_\${randomBytes(24).toString('base64url')}\`;
  const evs = Array.isArray(events) ? events.join(',') : (events || '*');
  const id = rowid(db.prepare('INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)').run(orgId, webhookUrl, secret, evs));
  logAudit(orgId, uid, 'webhook.create', 'webhook', id, { url: webhookUrl, events: evs });
  return c.json({ id, url: webhookUrl, events: evs, secret }); // secret shown once for signature verification
});`
);

fs.writeFileSync('server/app.mjs', newContent);
