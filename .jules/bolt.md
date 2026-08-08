## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2024-08-08 - DOM Node Creation Performance in Render Loops
**Learning:** Repeatedly creating multiple DOM nodes with `document.createElement()` inside `app.js` O(N) rendering loops (e.g. `createOwnerCellContent`, `createStatusCellContent`, `createActualProgressCellContent`, `createTextCellContent`) causes significant JS-to-C++ allocation overhead and GC pressure.
**Action:** Cache these DOM elements as unattached templates using a global variable, and instantiate them via `cloneNode(true/false)`. This significantly improves table rendering performance.
