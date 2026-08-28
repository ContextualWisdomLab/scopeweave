## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-15 - O(N) penalty with Map and reduce/forEach
**Learning:** Using Map caching and Array.prototype.reduce/forEach in O(N) loops incurs overhead from hash lookups, callback allocation, and garbage collection, degrading performance in hot paths.
**Action:** For high-performance O(N) loops in JavaScript, replace Array.prototype.reduce/forEach and Map caching with standard for loops and typed arrays (e.g., Int32Array) to eliminate JS engine overhead.
