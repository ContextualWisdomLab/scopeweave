## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2024-05-19 - String.padStart overhead in hot loops
**Learning:** Using `String.padStart(2, '0')` in hot loops like date formatters causes unnecessary string allocations and JS-to-C++ transition overhead, running roughly ~2.3x slower than inline ternary concatenation.
**Action:** For simple string padding in performance-critical paths (e.g., date zero-padding), prefer inline ternary operators like `m < 10 ? '0' + m : m`.
