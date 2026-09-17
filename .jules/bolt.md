## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2024-05-18 - Replacing map/reduce with typed arrays and for-loops
**Learning:** Using `reduce` and `forEach` along with `Map` for cache lookups in tight loops adds unnecessary overhead from function creation and hash lookups. Standard `for` loops combined with typed arrays (like `Float64Array`) and index-based lookups are significantly faster for numeric caching.
**Action:** When caching data across multiple iterations of the same unmodified array, use numeric array indices with a typed array rather than mapping by unique object properties (like `task.id`) to eliminate hash-lookup overhead.
