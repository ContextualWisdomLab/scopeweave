## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-10-02 - Add missing `modulepreload` links for critical scripts
**Learning:** Resource hints like `<link rel="modulepreload">` for all critical ES modules (like `analytics.js` and `cloud-sync.js`) ensure early discovery and parallel downloading, preventing waterfall request chains and reducing time-to-interactive.
**Action:** Always include `<link rel="modulepreload">` for all scripts loaded with `type="module"` in the main HTML document's `<head>`.
