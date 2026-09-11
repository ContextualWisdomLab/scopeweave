## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-11 - [Map and Array Loop Optimization]
**Learning:** Using `reduce` or `forEach` with JS engine callback allocation in high-performance O(N) loops incurs unnecessary garbage collection and processing overhead. While typed arrays (`Float64Array`) are normally ideal for sequential numeric caching, if a cache is inherently keyed by non-sequential unique properties (like string UUIDs for `task.id`), preserving a `Map` is necessary to maintain original overwrite semantics.
**Action:** Always replace `reduce` and `forEach` with standard `for` loops in critical calculation paths (like `computeTaskMetrics`). Evaluate if the keying mechanism allows sequential indexing (Array/TypedArray) or requires preserving a `Map` to avoid regressions in overwrite logic.
