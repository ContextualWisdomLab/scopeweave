## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-10-04 - DocumentFragment for batch appending
**Learning:** Using `parent.replaceChildren(...nodesArray)` forces the JS engine to handle large argument lists (which has scaling limits) and can be significantly slower than building a `DocumentFragment` iteratively and calling `replaceChildren(fragment)`.
**Action:** When updating a large container with an array of O(N) DOM nodes, iterate and append to a `DocumentFragment` first, then inject the fragment.
