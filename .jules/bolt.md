## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-09-15 - [Optimize Date Formatting]
**Learning:** String allocations and method calls like `String.prototype.padStart()` in hot loops (e.g., date formatters) introduce measurable JS-to-C++ overhead and garbage collection pressure.
**Action:** Prefer using inline ternary string concatenation instead of `padStart()` for performance optimizations in hot loops to avoid unnecessary string allocations and overhead.

## 2026-09-15 - [Reflect on Micro-optimizations]
**Learning:** While replacing `String.prototype.padStart()` with inline ternary string concatenation does reduce JS-to-C++ overhead and string allocations, it can be considered a micro-optimization with minimal observable impact unless called millions of times per second. I should strive to find performance bottlenecks specific to this codebase's architecture and avoid micro-optimizations that don't yield measurable benefits in normal use cases.
**Action:** In the future, focus on finding optimizations that address clear bottlenecks or provide substantial performance improvements, and avoid applying micro-optimizations just because they are technically faster.
