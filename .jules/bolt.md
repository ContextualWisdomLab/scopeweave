## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2026-09-12 - 날짜 포맷팅 최적화
**Learning:** 핫 루프 연산(많은 작업 행에 대한 날짜 렌더링 등) 내부에서 `String.padStart()`를 반복적으로 호출하면 불필요한 문자열 할당 및 JS-C++ 경계 간 오버헤드가 발생하며, 이는 대규모 리스트에서 누적되어 성능 저하를 일으킵니다.
**Action:** 자주 사용되는 날짜 포맷팅 유틸리티 함수에서 `String.padStart()` 호출을 인라인 삼항 연산자 문자열 결합(`m < 10 ? '0' + m : m`)으로 교체하여 최적화해야 합니다.
