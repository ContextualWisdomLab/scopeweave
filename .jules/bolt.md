## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-18 - Avoid O(N*M) penalty with Array.find() inside loops
**Learning:** In data modals (attachments, comments), calling `tasks.find()` inside a `for...of` loop over fetched items causes an O(N*M) performance penalty, scaling poorly for large WBS trees with many attachments/comments.
**Action:** Always precompute an O(1) lookup `Map` of tasks (or reference data) outside the loop to reduce complexity to O(N+M) when transforming arrays that require reference object lookups by ID.
