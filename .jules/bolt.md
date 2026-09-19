## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2024-05-18 - Readability over Typed Array micro-optimizations
**Learning:** While replacing standard objects like `Map` with typed arrays (like `Float64Array`) and index lookups can marginally improve performance in tight loops, doing so in typical business logic sacrifices code readability and violates the codebase rules against unreadable micro-optimizations.
**Action:** Replace `reduce`/`forEach` with standard `for` loops to eliminate function creation overhead, but retain standard data structures like `Map` for readability and clarity in general business logic.
