# Bounded DOM template caching and browser evidence

## Decision

ScopeWeave may reuse unattached owner/status badge templates in the WBS render
loop when all of the following remain true:

- every returned node is a clone rather than the cached node itself;
- the cache key contains every value that affects rendered text, class, title,
  and accessible name;
- each cache is bounded to 256 entries and uses least-recently-used eviction;
- owner color is deterministic and does not require an unbounded owner registry;
- empty cells and warning paths keep their existing semantics; and
- production-browser interaction tests accompany allocation-focused unit tests.

The optimization is deliberately limited to small immutable badge structures.
Editable controls, validation relationships, and elements whose event listeners
or mutable child state differ per row are not cached here.

## DOM correctness boundary

`cloneNode()` copies the node and its attributes. Its `deep` argument controls
whether child nodes are copied; it does not make JavaScript extension properties
or listeners registered through `addEventListener()` transferable. Cached
ScopeWeave templates therefore contain only DOM state that is safe to clone, and
callers receive a distinct node before any row-specific mutation.

Status-template identity is a serialized tuple of label, class name, and
description. This prevents two visually similar statuses with different
accessible explanations from sharing stale `title` or `aria-label` content.

## Resource bound

Both template maps have a hard 256-entry limit. A cache hit refreshes recency;
an insertion at capacity removes the least-recently-used key. This keeps
long-running workspaces with high-cardinality owner or status values from
retaining an unbounded collection of detached DOM nodes.

Owner colors are derived from a deterministic integer hash and the fixed
`OWNER_COLORS` palette. The same owner remains visually stable without retaining
all historical owners in memory.

## Test-first evidence

The focused unit contract verifies:

- semantically equal status objects share one entry;
- different descriptions cannot reuse stale accessible text;
- returned nodes are distinct clones;
- owner/status caches stay at or below 256 entries after high-cardinality input;
- 5,000 identical owners require only one template creation; and
- empty-value behavior remains unchanged.

The Playwright benchmark drives the production bootstrap and rendering path with
5,000 rows. It records:

- cold-load duration;
- five warm-render samples;
- median and p95 duration;
- long-task count and longest task;
- JavaScript heap deltas when the browser exposes them;
- live DOM-node counts;
- `document.createElement()` calls; and
- edit, drag, and inline-progress interaction success.

A prior hosted run on the mature implementation recorded warm durations of
5,596.4, 6,654.9, 7,199.2, 5,724.1, and 6,133.5 milliseconds, with a 6,133.5
millisecond median and 7,199.2 millisecond p95 for the 5,000-row path. It also
proved edit, drag, and inline-progress interactions. These numbers are execution
evidence, not a protected-base optimization delta.

## Interpretation limit

No protected-base browser A/B was executed in the same environment. The report
therefore emits:

```json
{
  "protectedBaselineAvailable": false,
  "targetPercent": 15,
  "targetMet": null,
  "optimizationDeltaPercent": null
}
```

Cold-load and warm-render values must not be compared as if they were before and
after measurements. A future performance claim requires randomized, repeated,
same-runner baseline and candidate samples with an explicit uncertainty model.
Until then, the merge gate proves bounded memory behavior, semantic parity,
production-path measurability, and interaction integrity rather than a claimed
percentage speedup.

## Rollback

Revert the template maps, helper, deterministic owner-color function, focused
unit contract, browser benchmark registration, CHANGELOG entries, and this
record together. A rollback does not change persisted WBS data or server APIs.

## References

Mozilla. (2026). *Node: cloneNode() method*. MDN Web Docs.
https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode

Web Hypertext Application Technology Working Group. (2026). *DOM standard*.
https://dom.spec.whatwg.org/

World Wide Web Consortium. (2017). *Long Tasks API 1*.
https://www.w3.org/TR/longtasks-1/

World Wide Web Consortium. (2024). *High Resolution Time Level 3*.
https://www.w3.org/TR/hr-time-3/
