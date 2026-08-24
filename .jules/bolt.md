## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-24 - Optimize computeTaskMetrics with Int32Array and standard loops
**Learning:** In hot loops over large array of tasks, using standard `for` loops and contiguous typed arrays (e.g., `Int32Array`) rather than standard `Map` caching and `Array.prototype.reduce`/`forEach` eliminates the overhead of JS engine callback allocation, garbage collection, and hash-lookups.
**Action:** Replace `Map` usages paired with functional iteration loops with standard indexed loops and TypedArrays for primitive data mappings whenever processing metrics for performance-critical high-iteration loops.
