## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-24 - Cache unattached templates in Gantt rendering loops
**Learning:** The application renders Gantt chart meta tables and track rows using O(N) loops. Continuously allocating DOM elements using `document.createElement` per cell/row results in significant JS-to-C++ instantiation overhead, just like rendering the main task table.
**Action:** Cache unattached templates (`tr`, `td`, `div`) outside the loop and use `.cloneNode(false)` inside the O(N) Gantt chart creation methods (`createGanttMetaTable` and `createGanttChartTable`).
