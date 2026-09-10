## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-12 - Date formatter의 String.padStart() 성능 페널티
**Learning:** `String.padStart()`와 같은 문자열 메서드는 렌더링 과정의 hot loop에서 불필요한 문자열 객체 할당 및 JS-C++ 브릿지 오버헤드를 발생시켜 성능 저하의 원인이 됨.
**Action:** 성능이 중요한 hot loop에서는 이러한 메서드 대신 인라인 3항 연산자를 이용한 문자열 병합(예: `m < 10 ? '0' + m : m`)을 사용하여 성능을 개선해야 함.
