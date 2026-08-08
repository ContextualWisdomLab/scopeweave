## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2024-08-08 - Array Pre-allocation for O(N) Filters
**Learning:** Using `Array.prototype.push()` in hot O(N) filtering loops like `getVisibleTasks` forces the JavaScript engine to dynamically reallocate and copy the backing C++ array multiple times as it grows, generating GC pressure and latency spikes.
**Action:** Pre-allocate the array to its maximum possible size (`new Array(maxLen)`), populate it using a tracking index, and slice it down at the end to significantly reduce array resizing overhead in critical rendering paths.
