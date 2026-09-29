## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-29 - Use Map instead of Array.find() for lookups in cloud sync
**Learning:** Using `Array.find()` inside loop renderings or repeated look-ups for cloud synchronization properties (e.g. `attachments` and `comments`) causes an O(N^2) bottleneck, unnecessarily degrading performance during data refresh.
**Action:** Replace `Array.find()` with a lazy-instantiated `Map` object inside closures that cache task definitions. This brings down lookup time complexity to O(1).
