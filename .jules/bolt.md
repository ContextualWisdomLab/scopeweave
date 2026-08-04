## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-08-04 - Promise.all prevents blocking loop cascades
**Learning:** Sequential `for...of` loops awaiting external network requests inside Node.js block execution, causing high latency proportional to the array size. `Promise.all` alongside array mapping ensures I/O bounds are executed concurrently, greatly reducing the response time and not tying up the async context unnecessarily.
**Action:** Use `Promise.all(rows.map(...))` whenever looping over items and performing asynchronous external database/network calls.
