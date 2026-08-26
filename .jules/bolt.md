## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-26 - Inline ternary concatenation vs String.padStart()
**Learning:** Using `String.prototype.padStart()` in hot loops (like date formatters inside O(N) chart rendering loops) causes unnecessary string allocations and JavaScript-to-C++ boundary crossings, increasing Garbage Collection pressure and degrading performance compared to inline ternary concatenation (`m < 10 ? '0' + m : m`).
**Action:** Prefer using inline ternary string concatenation for zero-padding short, bounded integers (e.g. months, days) in performance-critical hot loops instead of `String.prototype.padStart()`.
