## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2024-09-08 - O(N*M) lookup bottleneck in modal rendering
**Learning:** Found O(N*M) complexity where `Array.prototype.find()` was being used inside DOM rendering loops (attachments and comments modals) to map task IDs to task names. When projects scale up with many tasks and comments/attachments, this causes significant UI thread blocking.
**Action:** Always precompute a lookup `Map` (O(1)) outside of mapping/rendering loops for referenced objects by ID, instead of using `.find()` inside the loop.
