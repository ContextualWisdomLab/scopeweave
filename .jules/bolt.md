## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-13 - Cache immutable DOM shells, not input-bearing nodes
**Learning:** In high-frequency rendering loops, repeated `document.createElement()` calls and repeated configuration of static structure create avoidable DOM bridge and GC overhead. Templates must contain only immutable, non-customer-specific structure. Caching fully configured nodes keyed by owner names, labels, descriptions, titles, or accessible names retains row/user data in detached DOM and turns input cardinality into memory retention.
**Action:** Cache one bounded immutable shell per structural element type, clone it in the hot path, and apply row-specific text, classes, titles, and accessibility attributes only to the returned clone. Use fixed stylesheet classes for deterministic visual variants instead of inline styles or input-keyed DOM caches.
## 2026-07-13 - Correctly caching element attributes with cloneNode
**Learning:** Both `Node.cloneNode(false)` and `Node.cloneNode(true)` copy HTML attributes and their values, including reflected properties such as `title`. The `deep` argument controls only whether child nodes are cloned. JavaScript extension properties and listeners registered with `addEventListener()` are not cloned.
**Action:** Select shallow or deep cloning from the required child-node structure, not to preserve reflected attributes. Reapply JavaScript extension properties and event listeners explicitly when cached templates require them.
