## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-09-21 - Replaced findIndex with explicit loops
**Learning:** In hot render paths, using `Array.prototype.findIndex()` incurs an O(N) array scan per call. Converting these calls to explicit `for` loops improves iteration speed over large collections without the memory overhead of constructing an O(1) `Map` for one-off lookups, avoiding a net pessimization.
**Action:** Replaced `.findIndex()` with explicit `for` loops where one-off scans were occurring (e.g., in `app.js` and `analytics.js`).
