## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-16 - Optimize Gantt rendering DOM allocations
**Learning:** Instantiating deep DOM structures sequentially in O(N) rendering loops (e.g., Gantt charts) incurs significant JS-to-C++ allocation overhead. Caching and cloning template nodes avoids this overhead, reducing render time significantly (e.g., ~2.7s to ~1s for 500 tasks).
**Action:** Apply template caching with `.cloneNode()` in complex O(N) UI components like tables or charts.
