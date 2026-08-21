## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-21 - 핫 패스(hot paths)에서의 문자열 패딩 오버헤드
**Learning:** 날짜 포맷팅이 빈번하게 일어나는 핫 루프에서 `String.padStart(2, '0')`를 사용하면 불필요한 객체 할당과 JS에서 C++로의 전환 오버헤드가 발생한다는 것을 확인했습니다.
**Action:** 고정 너비 숫자 포맷팅에는 가비지 컬렉션 부담을 줄이고 실행 속도를 향상시키기 위해 `String.padStart()` 대신 인라인 삼항 연산자(예: `val < 10 ? '0' + val : val`)를 사용하도록 변경합니다.
