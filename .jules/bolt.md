## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-23 - String.padStart() 대신 삼항 연산자 사용으로 성능 최적화
**Learning:** 날짜 포맷팅 함수처럼 반복적으로 호출되는 루프에서 `String.padStart()`를 사용하면 불필요한 문자열 할당과 JS-C++ 간의 오버헤드가 발생합니다.
**Action:** 성능이 중요한 경로에서는 `String.padStart()` 등의 메서드 대신 삼항 연산자를 이용한 인라인 문자열 연결(`m < 10 ? "0" + m : m`)을 사용하여 오버헤드를 방지합니다.
