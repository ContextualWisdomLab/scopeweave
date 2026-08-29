## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2025-02-27 - 작업 지표 계산 루프 최적화 및 할당 오버헤드 제거
**Learning:** For high-performance O(N) loops in JavaScript, standard `for` loops and typed arrays (e.g., `Float64Array`) are faster than `Array.prototype.reduce`/`forEach` and `Map` caching because they eliminate JS engine callback allocation, garbage collection, and hash-lookup overhead.
**Action:** Replace `reduce`/`forEach` with standard `for` loops and use `Float64Array` for numeric caching in high-frequency calculation loops.
