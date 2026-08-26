## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-26 - Use Typed Arrays and For Loops for Metrics Calculation
**Learning:** Using `Map` caching and array methods like `reduce` and `forEach` introduces overhead from JS engine callback allocation, garbage collection, and hash-lookup, which can be significant in high-frequency functions like `computeTaskMetrics` that runs every render cycle.
**Action:** Replaced `Map` with typed arrays (`Int32Array`) and `reduce`/`forEach` with standard `for` loops for O(N) iteration in hot paths.
