## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-06 - Date 포매터의 성능 최적화
**Learning:** 핫 루프(hot loop) 내에서 `String.padStart()`를 사용하면 불필요한 문자열 할당과 JS-to-C++ 오버헤드가 발생하여 성능 저하의 원인이 됩니다.
**Action:** Date 포매터와 같이 자주 호출되는 함수에서는 `String.padStart()` 대신 인라인 삼항 연산자 문자열 연결(inline ternary string concatenation)을 사용하여 성능을 최적화해야 합니다.
