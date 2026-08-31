## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-12 - 핫루프 내 날짜 포맷 최적화 (String.padStart 회피)
**Learning:** `String.prototype.padStart()` 메서드는 편리하지만 핫루프(예: 날짜 포맷팅) 내에서 호출될 때 불필요한 문자열 객체 할당 오버헤드를 발생시켜 성능을 저하시킵니다. 특히 대량의 WBS 데이터를 렌더링하거나 처리할 때 이러한 오버헤드는 누적됩니다.
**Action:** 성능에 민감한 핫루프 내에서 단순한 패딩 처리가 필요한 경우, 항상 인라인 삼항 연산자 기반의 문자열 연결(예: `m < 10 ? '0' + m : m`)을 사용하여 할당 비용과 함수 호출 오버헤드를 줄이세요.
