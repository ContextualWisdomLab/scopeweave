## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-09-08 - Bolt: 작업 지표 계산 성능 최적화
**Learning:** Replaced `Array.prototype.reduce`/`forEach` and `Map` cache mapping with standard `for` loops and `Float64Array` typed array indices in hot-path `computeTaskMetrics` iterations. This eliminates continuous JS engine callback allocations, hash-lookup overheads, and unnecessary garbage collections for massive WBS datasets.
**Action:** When performing heavily looped metric computations referencing array indexes internally, fallback to standard `for` loop caching structures natively via numeric typed arrays (`Float64Array` or `Int32Array`) instead of allocating high-overhead structures like Maps or nested callbacks.
