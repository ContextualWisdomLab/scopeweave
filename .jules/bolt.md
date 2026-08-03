## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2024-05-30 - Fix N+1 query and sequential network latency in attachment updates
**Learning:** Sequential network calls inside a database loop (especially in `server/app.mjs` for attachment statuses) caused significant bottlenecks, simulating ~1200ms for 100 rows. By pre-fetching `job_id` in the initial `SELECT`, batching the updates in a single cached prepared statement, and utilizing `Promise.all()` for concurrent network requests, performance improved by ~90x.
**Action:** Implemented concurrent `jobStatus` resolution and cached `UPDATE` statements to fix the N+1 latency.
