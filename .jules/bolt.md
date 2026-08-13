## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-13 - Array reduce/forEach and Map to Int32Array and for loop optimization
**Learning:** For high-performance O(N) loops in JavaScript, standard for loops and typed arrays (like Int32Array) are significantly faster than Array.prototype methods and Map caching because they eliminate JS engine callback allocation, garbage collection, and hash-lookup overhead.
**Action:** Replace reduce/forEach and Map caching with for loops and Int32Array in hot paths.
## 2026-08-13 - Use Float64Array instead of Int32Array for Duration Metrics
**Learning:** Using  for storing duration logic will implicitly truncate floating-point numbers or invalid computations (), causing unintended logical regressions in JS applications where floating point precision might be relied upon.
**Action:** Default to  instead of  when optimizing JS loops for performance, unless integers are strictly guaranteed, to ensure semantic parity with native Javascript Arrays.
## $(date +%Y-%m-%d) - Use Float64Array instead of Int32Array for Duration Metrics
**Learning:** Using `Int32Array` for storing duration logic will implicitly truncate floating-point numbers or invalid computations (`NaN`), causing unintended logical regressions in JS applications where floating point precision might be relied upon.
**Action:** Default to `Float64Array` instead of `Int32Array` when optimizing JS loops for performance, unless integers are strictly guaranteed, to ensure semantic parity with native Javascript Arrays.
