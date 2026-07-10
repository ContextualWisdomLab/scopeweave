// Service-Request MANAGEMENT layer — end-to-end over the real Hono app (in-process,
// :memory: DB). Covers: PAT-authenticated ingestion (append/merge, no clobber),
// the work-item status state machine, Service-Request decomposition + rollup, and
// the request lifecycle (approve / auto-fulfill / close / reject guards).
// Run: node tests/api/service-requests.test.mjs
import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
const body = (o) => JSON.stringify(o);

// --- setup: owner + project ---------------------------------------------------
let r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'owner@sr.com', password: 'password123', name: 'Owner' }) });
const token = (await r.json()).token;
const auth = { authorization: `Bearer ${token}` };
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'SR 프로젝트' }) });
const proj = await r.json();

// seed a native task via the normal PUT so we can prove import does NOT clobber it
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'native-1', name: '기존 수기 작업', actualProgress: 100 }], version: 1 }) });
assert.equal(r.status, 200);

// --- PAT-authenticated ingestion ---------------------------------------------
r = await req('/api/tokens', { method: 'POST', headers: auth, body: body({ name: 'ingest' }) });
const pat = (await r.json()).token;
assert.ok(pat.startsWith('swk_'), 'PAT minted');
const patAuth = { authorization: `Bearer ${pat}` };

const payload = {
  items: [
    { uid: 'EPIC-1', title: '인증 개선', kind: 'feature' },
    { uid: 'REQ-42', title: '비밀번호 재설정', kind: 'requirement', source_segment_uids: ['seg-1', 'seg-2'], confidence: 0.9, edges: [{ rel: 'child_of', to: 'EPIC-1' }] },
    { uid: 'ISS-7', title: '로그인 실패 로깅 누락', kind: 'issue', confidence: 0.6 },
  ],
};
r = await req(`/api/projects/${proj.id}/tasks:import`, { method: 'POST', headers: patAuth, body: body(payload) });
assert.equal(r.status, 200, 'PAT can hit the import endpoint');
let imp = await r.json();
assert.equal(imp.created, 3, 'three work items created');
assert.equal(imp.updated, 0, 'nothing updated on first import');

// verify tree: native task preserved + imported items carry provenance/kind
r = await req(`/api/projects/${proj.id}`, { headers: auth });
let tree = (await r.json()).tasks;
assert.ok(tree.find((t) => t.id === 'native-1' && t.actualProgress === 100), 'native task NOT clobbered by import');
const req42 = tree.find((t) => t.id === 'imp-REQ-42');
assert.equal(req42.kind, 'requirement', 'kind stored on work item');
assert.deepEqual(req42.source_segment_uids, ['seg-1', 'seg-2'], 'source_segment_uids stored as evidence');
assert.equal(req42.evidence_confidence, 0.9, 'confidence stored');
assert.equal(req42.parentId, 'imp-EPIC-1', 'edge resolved to parent nesting');

// re-import same payload with an edit → UPDATE in place, no duplicates, no clobber
r = await req(`/api/projects/${proj.id}/tasks:import`, { method: 'POST', headers: patAuth, body: body({ items: [{ uid: 'REQ-42', title: '비밀번호 재설정(개정)', kind: 'requirement' }] }) });
imp = await r.json();
assert.equal(imp.created, 0, 're-import creates nothing');
assert.equal(imp.updated, 1, 're-import updates the existing item');
r = await req(`/api/projects/${proj.id}`, { headers: auth });
tree = (await r.json()).tasks;
assert.equal(tree.filter((t) => t.id === 'imp-REQ-42').length, 1, 'no duplicate created');
assert.equal(tree.find((t) => t.id === 'imp-REQ-42').name, '비밀번호 재설정(개정)', 'title updated');

// import auth + validation guards
assert.equal((await req(`/api/projects/${proj.id}/tasks:import`, { method: 'POST', body: body(payload) })).status, 401, 'no auth → 401');
assert.equal((await req(`/api/projects/${proj.id}/tasks:import`, { method: 'POST', headers: patAuth, body: body({ items: [] }) })).status, 400, 'empty items → 400');

// --- work-item status state machine ------------------------------------------
// native-1 was 100% → derives to 'done'; move imp-ISS-7 open → in_progress → done
r = await req(`/api/projects/${proj.id}/tasks/imp-ISS-7/status`, { method: 'PATCH', headers: auth, body: body({ to: 'in_progress' }) });
assert.equal(r.status, 200, 'open → in_progress');
r = await req(`/api/projects/${proj.id}/tasks/imp-ISS-7/status`, { method: 'PATCH', headers: auth, body: body({ to: 'done' }) });
assert.equal(r.status, 200, 'in_progress → done');
// illegal transition (done → cancelled) rejected by the state machine
r = await req(`/api/projects/${proj.id}/tasks/imp-ISS-7/status`, { method: 'PATCH', headers: auth, body: body({ to: 'cancelled' }) });
assert.equal(r.status, 409, 'illegal task transition → 409');
// unknown status value + unknown task guarded
assert.equal((await req(`/api/projects/${proj.id}/tasks/imp-ISS-7/status`, { method: 'PATCH', headers: auth, body: body({ to: 'bogus' }) })).status, 400, 'bad status → 400');
assert.equal((await req(`/api/projects/${proj.id}/tasks/nope/status`, { method: 'PATCH', headers: auth, body: body({ to: 'done' }) })).status, 404, 'unknown task → 404');

// --- Service Request: intake → approve → decompose → rollup → fulfill ---------
r = await req(`/api/projects/${proj.id}/service-requests`, { method: 'POST', headers: auth, body: body({
  title: '신규 담당자 온보딩 환경 요청', catalogItem: 'onboarding', priority: 'high',
  performingTeam: '플랫폼팀', slaDueAt: '2026-08-01', sourceSegmentUids: ['doc-3'], confidence: 0.8,
}) });
assert.equal(r.status, 200, 'service request intake');
let sr = await r.json();
assert.equal(sr.status, 'submitted', 'starts submitted');
assert.equal(sr.priority, 'high');
assert.deepEqual(sr.sourceSegmentUids, ['doc-3'], 'request carries its evidence');
assert.equal(sr.fulfillmentState, 'pending', 'no work yet');

// intake requires a title
assert.equal((await req(`/api/projects/${proj.id}/service-requests`, { method: 'POST', headers: auth, body: body({}) })).status, 400, 'title required');

// cannot fulfill/close before approval
assert.equal((await req(`/api/projects/${proj.id}/service-requests/${sr.id}/transition`, { method: 'POST', headers: auth, body: body({ to: 'closed' }) })).status, 409, 'cannot close a submitted request');

// approve → decomposes into two linked work items on the board
r = await req(`/api/projects/${proj.id}/service-requests/${sr.id}/approve`, { method: 'POST', headers: auth, body: body({
  tasks: [
    { name: '계정 프로비저닝', owner: '플랫폼팀', kind: 'task' },
    { name: '노트북 지급', owner: 'IT지원', kind: 'task' },
  ],
}) });
assert.equal(r.status, 200, 'approve + decompose');
sr = await r.json();
assert.equal(sr.status, 'approved', 'request approved');
assert.equal(sr.createdTasks.length, 2, 'two linked work items created');
assert.equal(sr.rollup.total, 2, 'rollup sees both children');
assert.equal(sr.fulfillmentState, 'pending', 'children start open → pending');
assert.ok(sr.approvedBy && sr.approvedAt, 'approval stamped');
const childIds = sr.createdTasks.map((t) => t.id);

// the decomposed tasks really live on the tree, linked back to the request
r = await req(`/api/projects/${proj.id}`, { headers: auth });
tree = (await r.json()).tasks;
assert.equal(tree.filter((t) => String(t.service_request_id) === String(sr.id)).length, 2, 'linked tasks appended to tree');
assert.ok(tree.find((t) => t.id === 'native-1'), 'approval decomposition did not clobber the tree');

// move ONE child to done → request auto-advances to in_progress
r = await req(`/api/projects/${proj.id}/tasks/${childIds[0]}/status`, { method: 'PATCH', headers: auth, body: body({ to: 'done' }) });
assert.equal(r.status, 200);
let after = (await r.json()).serviceRequest;
assert.equal(after.status, 'in_progress', 'partial completion → request in_progress');
assert.equal(after.rollup.done, 1);
assert.equal(after.fulfillmentState, 'in_progress');

// complete the SECOND child → rollup fulfills the request automatically
r = await req(`/api/projects/${proj.id}/tasks/${childIds[1]}/status`, { method: 'PATCH', headers: auth, body: body({ to: 'done' }) });
after = (await r.json()).serviceRequest;
assert.equal(after.status, 'fulfilled', 'all children done → request fulfilled by rollup');
assert.equal(after.fulfillmentState, 'fulfilled');
assert.ok(after.fulfilledAt, 'fulfilledAt stamped');

// reopening a child regresses the request back to in_progress (rollup is live)
r = await req(`/api/projects/${proj.id}/tasks/${childIds[1]}/status`, { method: 'PATCH', headers: auth, body: body({ to: 'in_progress' }) });
after = (await r.json()).serviceRequest;
assert.equal(after.status, 'in_progress', 'reopened child regresses request');
// re-complete then close
await req(`/api/projects/${proj.id}/tasks/${childIds[1]}/status`, { method: 'PATCH', headers: auth, body: body({ to: 'done' }) });
r = await req(`/api/projects/${proj.id}/service-requests/${sr.id}/transition`, { method: 'POST', headers: auth, body: body({ to: 'closed', note: '요청자 확인 완료' }) });
assert.equal(r.status, 200, 'fulfilled → closed');
assert.equal((await r.json()).status, 'closed');

// --- detail view: linked tasks + event history --------------------------------
r = await req(`/api/projects/${proj.id}/service-requests/${sr.id}`, { headers: auth });
const detail = await r.json();
assert.equal(detail.linkedTasks.length, 2, 'detail lists linked work items');
assert.ok(detail.events.some((e) => e.toStatus === 'approved') && detail.events.some((e) => e.toStatus === 'closed'), 'lifecycle events recorded');
assert.ok(detail.events.some((e) => e.toStatus === 'fulfilled'), 'auto-fulfill event recorded');

// --- authorization guards -----------------------------------------------------
// a viewer can read but neither create nor approve
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'viewer@sr.com', password: 'password123' }) });
const vAuth = { authorization: `Bearer ${(await r.json()).token}` };
r = await req('/api/me', { headers: auth });
const orgId = (await r.json()).orgs[0].id;
const inv = await (await req(`/api/orgs/${orgId}/invites`, { method: 'POST', headers: auth, body: body({ email: 'viewer@sr.com', role: 'viewer' }) })).json();
await req(`/api/invites/${inv.token}/accept`, { method: 'POST', headers: vAuth });
assert.equal((await req(`/api/projects/${proj.id}/service-requests`, { headers: vAuth })).status, 200, 'viewer can list');
assert.equal((await req(`/api/projects/${proj.id}/service-requests`, { method: 'POST', headers: vAuth, body: body({ title: 'x' }) })).status, 403, 'viewer cannot raise');
assert.equal((await req(`/api/projects/${proj.id}/tasks:import`, { method: 'POST', headers: vAuth, body: body(payload) })).status, 403, 'viewer cannot import');
// a fresh submitted request: viewer cannot approve
r = await req(`/api/projects/${proj.id}/service-requests`, { method: 'POST', headers: auth, body: body({ title: '두번째 요청' }) });
const sr2 = await r.json();
assert.equal((await req(`/api/projects/${proj.id}/service-requests/${sr2.id}/approve`, { method: 'POST', headers: vAuth, body: body({}) })).status, 403, 'viewer cannot approve');
// reject path (approve default single-issue decomposition too)
r = await req(`/api/projects/${proj.id}/service-requests/${sr2.id}/transition`, { method: 'POST', headers: auth, body: body({ to: 'rejected', note: '중복 요청' }) });
assert.equal((await r.json()).status, 'rejected', 'owner can reject a submitted request');

// approve with NO task specs → defaults to a single mirroring issue
r = await req(`/api/projects/${proj.id}/service-requests`, { method: 'POST', headers: auth, body: body({ title: '기본 분해 요청' }) });
const sr3 = await r.json();
r = await req(`/api/projects/${proj.id}/service-requests/${sr3.id}/approve`, { method: 'POST', headers: auth, body: body({}) });
assert.equal((await r.json()).createdTasks.length, 1, 'default decomposition → one issue');

// --- tenant isolation ---------------------------------------------------------
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'outsider@sr.com', password: 'password123' }) });
const oAuth = { authorization: `Bearer ${(await r.json()).token}` };
assert.equal((await req(`/api/projects/${proj.id}/service-requests`, { headers: oAuth })).status, 404, 'non-member SR list → 404');
assert.equal((await req(`/api/projects/${proj.id}/tasks:import`, { method: 'POST', headers: oAuth, body: body(payload) })).status, 404, 'non-member import → 404');

console.log('✓ service-request management tests passed');
