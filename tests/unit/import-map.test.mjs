// Ingestion mapping + non-clobbering merge + rollup (pure logic in server/import-map.mjs).
// Run: node tests/unit/import-map.test.mjs
import assert from 'node:assert';
import { mapSemanticObject, mapPayload, mergeWorkItems, rollupChildren, childrenOf } from '../../server/import-map.mjs';

// ---- mapSemanticObject: ProjectSemanticObject → work item --------------------
const obj = mapSemanticObject({
  uid: 'REQ-42',
  title: '사용자는 비밀번호를 재설정할 수 있어야 한다',
  kind: 'requirement',
  source_segment_uids: ['seg-1', 'seg-2', ''],
  confidence: 0.87,
  edges: [{ rel: 'parent', to: 'REQ-1' }, { rel: 'depends_on', to: 'REQ-9' }],
  owner: '보안팀',
});
assert.equal(obj.id, 'imp-REQ-42', 'stable id derived from external uid');
assert.equal(obj.name, '사용자는 비밀번호를 재설정할 수 있어야 한다', 'title → name');
assert.equal(obj.kind, 'requirement', 'kind preserved');
assert.equal(obj.status, 'open', 'new work items start open');
assert.deepEqual(obj.source_segment_uids, ['seg-1', 'seg-2'], 'citations → source_segment_uids (blanks dropped)');
assert.equal(obj.evidence_confidence, 0.87, 'confidence → evidence_confidence meta');
assert.equal(obj.owner, '보안팀', 'owner mapped');
assert.deepEqual(obj.edges, [{ rel: 'depends_on', to: 'REQ-9' }], 'non-structural edge kept; parent edge consumed for nesting');

// invalid kind falls back to issue; missing title rejected; confidence clamped
assert.equal(mapSemanticObject({ uid: 'x', title: 't', kind: 'bogus' }).kind, 'issue', 'unknown kind → issue');
assert.equal(mapSemanticObject({ uid: 'x', title: 't', confidence: 5 }).evidence_confidence, 1, 'confidence clamped to 1');
assert.throws(() => mapSemanticObject({ uid: 'x', title: '' }), /title/, 'blank title rejected');

// ---- mapPayload: resolves parent edges to imported ids -----------------------
const items = mapPayload({
  items: [
    { uid: 'EPIC-1', title: '인증 개선', kind: 'feature' },
    { uid: 'REQ-42', title: '비밀번호 재설정', kind: 'requirement', edges: [{ type: 'child_of', target: 'EPIC-1' }] },
  ],
});
assert.equal(items.length, 2);
assert.equal(items[0].parentId, null, 'root has no parent');
assert.equal(items[1].parentId, 'imp-EPIC-1', 'child edge resolved to imported parent id');
assert.throws(() => mapPayload({ items: [] }), /no importable/, 'empty payload rejected');

// ---- mergeWorkItems: append/merge WITHOUT clobbering the tree ----------------
const existing = [
  { id: 'imp-REQ-42', name: '옛 제목', kind: 'requirement', status: 'in_progress', actualProgress: 40, owner: '홍길동' },
  { id: 'native-1', name: '기존 수기 작업', actualProgress: 100 },
];
const incoming = mapPayload({
  items: [
    { uid: 'REQ-42', title: '비밀번호 재설정(수정)', kind: 'requirement', source_segment_uids: ['seg-9'] },
    { uid: 'REQ-77', title: '신규 이슈', kind: 'issue' },
  ],
});
const { tasks, created, updated } = mergeWorkItems(existing, incoming);
assert.equal(created, 1, 'one new work item appended');
assert.equal(updated, 1, 'one existing work item updated');
assert.equal(tasks.length, 3, 'tree grew by one, nothing dropped');
assert.ok(tasks.some((t) => t.id === 'native-1' && t.actualProgress === 100), 'untouched native task preserved verbatim');
const merged = tasks.find((t) => t.id === 'imp-REQ-42');
assert.equal(merged.name, '비밀번호 재설정(수정)', 'title updated on re-import');
assert.equal(merged.actualProgress, 40, 'existing progress NOT clobbered');
assert.equal(merged.status, 'in_progress', 'in-flight status not downgraded to open');
assert.equal(merged.owner, '홍길동', 'existing owner preserved when import omits it');
assert.ok(merged.source_segment_uids.includes('seg-9'), 'new evidence merged in');
// input arrays are never mutated
assert.equal(existing.length, 2, 'existing input array not mutated');

// ---- rollup: child completion drives fulfillment -----------------------------
assert.equal(rollupChildren([]).fulfillmentState, 'pending', 'no children → pending');
assert.equal(rollupChildren([{ status: 'open' }, { status: 'open' }]).fulfillmentState, 'pending', 'all open → pending');
const partial = rollupChildren([{ status: 'done' }, { status: 'open' }]);
assert.equal(partial.fulfillmentState, 'in_progress', 'some done → in_progress');
assert.equal(partial.ratio, 0.5, 'ratio = done/active');
assert.equal(rollupChildren([{ status: 'done' }, { actualProgress: 100 }]).fulfillmentState, 'fulfilled', 'all done (mixed status/percent) → fulfilled');
// cancelled children are excluded from the "active" denominator
assert.equal(rollupChildren([{ status: 'done' }, { status: 'cancelled' }]).fulfillmentState, 'fulfilled', 'cancelled excluded → remaining all done');

// ---- childrenOf: link filter -------------------------------------------------
const tree = [{ id: 'a', service_request_id: 5 }, { id: 'b', service_request_id: 6 }, { id: 'c' }];
assert.deepEqual(childrenOf(tree, 5).map((t) => t.id), ['a'], 'filters by service_request_id');

console.log('✓ import-map (ingestion + merge + rollup) tests passed');
