## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-08-10 - Optimize Gantt Chart Rendering with cloneNode
**Learning:** In vanilla HTML/JS applications, repeatedly calling `document.createElement()` within large O(N) rendering loops (e.g., rendering hundreds of Gantt chart rows) introduces significant JS-to-C++ allocation overhead and GC pressure.
**Action:** Always cache static unattached DOM structures as templates outside the loop and instantiate them via `.cloneNode(false)` or `.cloneNode(true)`. This minimizes cross-language boundary costs and yields measurable performance gains.
