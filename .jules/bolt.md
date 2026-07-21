## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-20 - Topological sorting property of state.tasks
**Learning:** The `state.tasks` array is maintained in a topologically sorted order (parents always precede children). I discovered that I can leverage this property to process hierarchical states (like visibility filtering or subtree deletion) in a single O(N) top-down pass, avoiding O(N*Depth) recursive traversals or maintaining intermediate BFS queues / maps.
**Action:** When filtering or modifying hierarchical subtrees in `state.tasks`, rely on the pre-sorted topological order by accumulating states top-down in a Set or array rather than doing BFS/DFS.
