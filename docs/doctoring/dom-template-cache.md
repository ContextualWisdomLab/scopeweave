# Immutable DOM badge shells and browser evidence

## Decision status

This record describes an **active pull-request implementation**, not protected-`develop`
truth until integration completes. ScopeWeave may reuse unattached owner/status badge
shells in the WBS render loop only when all of the following remain true:

- every returned node is a clone rather than the cached shell itself;
- cached shells contain no task, owner, status, title, description, accessible name,
  or other row-specific value;
- row-specific text, classes, `title`, and `aria-label` values are applied only after
  cloning;
- owner colors use a fixed set of stylesheet classes rather than inline styles or an
  owner-value registry;
- empty cells and warning paths keep their existing semantics; and
- production-browser interaction tests accompany allocation-focused unit tests.

The optimization is deliberately limited to small immutable badge structures.
Editable controls, validation relationships, and elements whose event listeners or
mutable child state differ per row are not cached here.

## DOM correctness and privacy boundary

`cloneNode()` copies the node and its attributes. Its `deep` argument controls whether
child nodes are copied; it does not transfer listeners registered through
`addEventListener()`. ScopeWeave therefore keeps the two cached badge shells free of
row-specific attributes and child text, clones them shallowly, and mutates only the
returned clone.

This boundary is also a data-retention control. Owner names and status explanations
are not used as DOM-cache keys and are not retained in detached template nodes.
High-cardinality customer values therefore cannot grow a detached-node cache or leave
historical row text in reusable templates.

## Resource bound and deterministic color

The owner badge uses one immutable shell and the status badge uses one immutable
shell. Their memory bound is therefore structural rather than an input-cardinality
LRU limit. A deterministic integer hash maps an owner string to one of 20 fixed
`owner-badge--color-N` classes defined in `styles.css`; the shell itself contains no
owner value and no inline `background` style.

This supersedes the earlier 256-entry input-keyed owner/status template maps. That
approach bounded entry count but still retained task/user data in cache keys and
detached DOM nodes.

## Metadata-only render integration

Project-name persistence remains on the single user-visible `renderAll()` integration
path. `renderAll({ metadataOnly: true })` refreshes project metadata and returns before
metric calculation, analytics, visible-task construction, and task-grid replacement.
Base-date changes continue through the full render path because they affect schedule
metrics.

## Test-first evidence contract

The focused unit contract verifies that:

- cached owner/status shells do not retain row text, title, accessible name, or inline
  color;
- returned nodes are distinct clones populated with the correct current row value;
- a changed status description appears on the returned clone without mutating the
  cached shell;
- 300 unique status values and 300 unique owners allocate no new template elements
  after their respective shell is initialized;
- 5,000 identical owners likewise allocate no new template elements after shell
  initialization; and
- empty-value behavior remains unchanged.

The Playwright benchmark drives the production bootstrap and rendering path with 5,000
rows. For each warm project-name edit it records duration, `document.createElement()`
calls, heap delta when available, live DOM-node count, and whether the first task-row
node retained identity. The candidate contract requires **every** warm metadata sample
to create zero elements and preserve task-grid identity. Edit, inline-progress, and
drag/reorder probes remain acceptance checks in the same browser run.

## Evidence interpretation

A prior hosted A/B run demonstrated a large metadata-edit improvement against its then
protected base, but predecessor-head or predecessor-base success is not exact-current-
head evidence. After any source, test, documentation, stylesheet, or base-reconciliation
change, the PR must regenerate browser and repository-native evidence for the unchanged
exact contributor head and independently resolved live protected base before the result
can support merge or release.

Cold-load and long-task values remain diagnostic unless the benchmark is explicitly
designed and powered for claims about those outcomes. The performance claim for this
slice is limited to the project-name metadata-edit hot path.

## Rollback

Revert the immutable badge-shell helpers, fixed owner color classes, focused unit
contract, metadata-sample assertion, browser benchmark registration, changelog entry,
and this record together. A rollback does not change persisted WBS data or server APIs.

## References

Mozilla. (2026). *Node: cloneNode() method*. MDN Web Docs.
https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode

Web Hypertext Application Technology Working Group. (2026). *DOM standard*.
https://dom.spec.whatwg.org/

World Wide Web Consortium. (2017). *Long Tasks API 1*.
https://www.w3.org/TR/longtasks-1/

World Wide Web Consortium. (2024). *High Resolution Time Level 3*.
https://www.w3.org/TR/hr-time-3/
