## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-25 - Benchmark fixed-width date formatting before accepting micro-optimizations
**Learning:** Engine-internal explanations are not acceptance evidence. A fixed-width date formatter optimization must preserve every observable output while demonstrating a material median improvement against an immutable protected-base revision in the same browser/runtime.
**Action:** Keep date-format micro-optimizations only when the protected Chromium A/B benchmark proves exact semantic parity across a leap-year date corpus and at least a 10% median improvement; otherwise prefer the clearer implementation.
