## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-21 - Optimize resource hinting for module scripts
**Learning:** Adding `<link rel="modulepreload">` tags in the document `<head>` for late-loaded `<script type="module">` modules at the bottom of `<body>` is a valid resource hinting optimization. It instructs the browser to download and compile modules earlier in the critical rendering path.
**Action:** When working on performance, utilize `<link rel="modulepreload">` for important module scripts to speed up loading instead of relying solely on bottom-body placement.
