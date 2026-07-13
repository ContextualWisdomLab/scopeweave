## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-13 - O(N) penalty with Date parsing in render loops
**Learning:** Repetitive string-to-date parsing (`new Date()`, `getMonday`, etc) within a timeline generation loop creates significant GC pressure and CPU overhead. By calculating with `Date.UTC()` integer milliseconds and pre-calculating groupings (like `monday`), timeline generation time was improved by ~2.5x.
**Action:** Always prefer manipulating dates as UTC millisecond integers during loop operations and only format to strings at the end. Carry derived data in loops rather than recomputing it downstream.
