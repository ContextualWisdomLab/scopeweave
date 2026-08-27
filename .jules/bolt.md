## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2023-10-27 - [Avoid String.padStart in Hot Loops]
**Learning:** `String.padStart()` introduces unnecessary string allocations and JS-to-C++ context switching overhead in tight rendering loops like date formatters.
**Action:** Prefer using inline ternary string concatenation (e.g., `m < 10 ? '0' + m : m`) instead of `String.prototype.padStart()` for dynamic string padding in hot paths to avoid JS-to-C++ overhead and improve performance.
