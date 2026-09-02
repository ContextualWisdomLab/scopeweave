## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2024-11-20 - Resource Discovery Optimization
**Learning:** In purely static applications without a bundler, dynamic module imports (or late-discovered ES modules in the body) cause waterfall network requests, significantly increasing Time to Interactive (TTI).
**Action:** Always add `<link rel="modulepreload">` for all critical top-level ES modules in the `<head>` of `index.html` to allow the browser to fetch and parse them concurrently with HTML parsing.
