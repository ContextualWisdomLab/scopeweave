## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-12 - Eliminate padStart in hot-path Date formatters
**Learning:** Using `String.padStart()` in hot loops (e.g., date formatting functions repeatedly called during `computeTaskMetrics` or timeline generation) causes unnecessary string allocations and JS-to-C++ bridge overhead.
**Action:** Prefer using inline ternary string concatenation (e.g., `value < 10 ? '0' + value : value`) for zero-padding in performance-critical sections to reduce GC pressure.
