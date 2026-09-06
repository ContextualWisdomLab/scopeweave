## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-06 - O(N*M) penalty in array searches within nested loops
**Learning:** Using `Array.prototype.find()` on a list (e.g. `state.tasks`) inside a loop over another list (e.g. comments or attachments) causes O(N*M) time complexity, leading to severe slowdowns as the number of items grows.
**Action:** When repeatedly looking up items by ID inside a loop, always precompute an O(1) lookup `Map` of the target collection before the loop.
