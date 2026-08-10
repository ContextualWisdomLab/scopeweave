## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-08-10 - JSDOM Global Caching Danger
**Learning:** Caching unattached DOM elements in module-level global variables (e.g., `let rowTemplate = document.createElement('tr')`) and reusing them via `cloneNode()` across renders is a dangerous anti-pattern in environments tested with JSDOM. JSDOM recreates the `document` context per test. Cloned nodes retain the original `document` reference, causing `HierarchyRequestError` or `WrongDocumentError` when appending them to a new test's `document`.
**Action:** Avoid global DOM caching optimizations in frontend codebases heavily reliant on JSDOM. If caching is necessary for extreme performance, encapsulate the template cache within a factory function or class that is scoped to the current `document` instance, or ensure templates are re-initialized when the `document` context changes.
