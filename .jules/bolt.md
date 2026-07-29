## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-29 - Optimize date formatters in hot loops
**Learning:** In V8 and other modern JavaScript engines, using `String.padStart()` in hot loops (like processing thousands of dates) creates significant GC pressure and overhead from JS-to-C++ boundary crossings and intermediate string object allocations.
**Action:** Replace `String(val).padStart(2, '0')` with inline ternary concatenation (e.g., `val < 10 ? '0' + val : val`) in performance-critical formatters.
