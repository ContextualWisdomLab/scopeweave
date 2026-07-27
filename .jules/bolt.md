## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-12 - Inline ternary concatenation over String.padStart()
**Learning:** In hot loops and frequent formatting paths like date conversion, using `String.padStart(2, '0')` introduces unnecessary JS string wrapper object allocations and crosses the JS-to-C++ bridge. Replacing it with inline ternary concatenation (e.g., `m < 10 ? '0' + m : m`) significantly reduces overhead and GC pressure.
**Action:** Prefer inline math and string concatenation over `String.prototype` methods in performance-sensitive formatters.
