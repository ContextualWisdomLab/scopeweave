## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-13 - Use Float64Array instead of Map and Array.prototype for high-performance loops
**Learning:** For high-performance O(N) loops in JavaScript, standard for loops and typed arrays (like `Float64Array`) are significantly faster than `Array.prototype` methods (`reduce`/`forEach`) and `Map` caching. They eliminate JS engine callback allocation, garbage collection, and hash-lookup overhead. Using `Int32Array` can implicitly truncate floats or `NaN`s causing logical regressions, so `Float64Array` should be the default for semantic parity with native JS Arrays.
**Action:** Replace `reduce`/`forEach` and `Map` caching with `for` loops and `Float64Array` in hot paths.
