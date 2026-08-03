## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-03 - Reuse DOM templates without overstating performance
**Learning:** Reusing unattached template nodes can reduce repeated element setup, but this refactor has no reproducible browser benchmark yet and must not be presented as a measured speed, memory, or GC improvement.
**Action:** Treat template cloning as an internal allocation refactor, prove that row-specific text, classes, titles, ARIA state, labels, and IDs remain isolated, and require a deterministic benchmark before making quantitative performance claims.
