## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-03 - Measure date-formatter changes before generalizing
**Learning:** Replacing `String.prototype.padStart()` with inline zero-padding can reduce formatter cost in a particular JavaScript runtime, but a microbenchmark alone does not establish browser Gantt p95, GC pressure, or a JS-to-C++ boundary as the cause. The production claim must follow the measured ScopeWeave page/path workload rather than a runtime implementation assumption.
**Action:** Preserve semantic-equivalence coverage for date formatting and require a representative browser/workload measurement before treating the formatter change as buyer-visible performance evidence. Record runtime, data volume, sample count, warm-up policy, p50/p95, and allocation/main-thread observations; do not exclude slow samples or rely on unrealistic cache warm-up.
