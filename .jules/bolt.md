## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-03 - Measure date-formatting micro-optimizations before generalizing
**Learning:** In a bounded Node/V8 microbenchmark, explicit two-digit zero-padding can be faster than `String.prototype.padStart()` for the same formatter output. That measurement does not establish browser Gantt p95, allocation/GC pressure, or a JS/native-boundary root cause.
**Action:** Preserve formatter behavior with executable UTC/local/zero-padding/invalid-date regression coverage. Apply the inline form only where representative profiling supports it, and keep buyer-visible performance claims separate from microbenchmark evidence.
