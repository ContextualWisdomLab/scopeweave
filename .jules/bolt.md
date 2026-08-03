## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-03 - String.padStart() causes JS-to-C++ overhead in hot loops
**Learning:** Using `String.padStart()` in hot loops like date formatting functions creates unnecessary string allocations and incurs a JS-to-C++ transition overhead, which degrades performance when called repeatedly in large datasets.
**Action:** Use inline ternary string concatenation (e.g., `m < 10 ? '0' + m : m`) instead of `String.prototype.padStart()` for simple padding operations in performance-critical sections to avoid this overhead.
