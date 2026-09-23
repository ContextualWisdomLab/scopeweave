## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-23 - Avoid redundant allocation with padStart in formatting functions
**Learning:** Functions like `padStart` create intermediate string allocations which can cause GC pressure when formatting thousands of dates in tight loops (e.g., Gantt charts). Manual integer arithmetic and direct string concatenation with `year`, `month`, and `day` using standard UTC/local accessors (`getUTCFullYear()`, `getUTCMonth()`, etc.) significantly reduces overhead. Additionally, `Date` instantiation and timestamp math avoid creating multiple small array segments.
**Action:** Replace `String().padStart()` with fast inline conditionals (e.g. `month < 10 ? '0' + month : month`) and precalculate loop boundaries as integer timestamps instead of strings when performing dense date generation.
