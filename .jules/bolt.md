## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-31 - [High-performance metric aggregation]
**Learning:** For high-performance O(N) loops in JavaScript, replacing `Array.prototype.reduce`/`forEach` and `Map` caching with standard `for` loops and typed arrays (`Float64Array`) eliminates JS engine callback allocation, garbage collection, and hash-lookup overhead. This allows for faster metric computations, specifically when iterating over large datasets in hot code paths.
**Action:** Use typed arrays over Maps for O(N) primitive storage caches when iteration indices map directly to indices, and use `for` loops instead of functional iteration methods for critical hot paths.
