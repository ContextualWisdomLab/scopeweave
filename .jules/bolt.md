## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-09-18 - [Optimize Asset Loading]
**Learning:** Adding `<link rel="modulepreload">` tags for dynamically or declaratively loaded ES modules (like `cloud-sync.js` and `analytics.js`) allows the browser to discover and fetch these resources earlier in the page lifecycle. This eliminates waterfall request delays and improves the time to interactive (TTI) for module-based frontends.
**Action:** Use `modulepreload` tags in the `<head>` of HTML documents for critical JavaScript modules to ensure they are fetched in parallel with other critical resources.
