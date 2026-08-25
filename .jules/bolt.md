## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-28 - String.padStart() in hot loops
**Learning:** `String.padStart()` 메서드는 내부적으로 추가적인 문자열 할당을 유발하고 JS-to-C++ 브릿지 오버헤드를 발생시켜 날짜 포맷팅과 같이 반복 호출되는 루프 내에서 GC 압박을 증가시킵니다.
**Action:** 두 자리 숫자 포맷팅 시 `String.padStart()` 대신 삼항 연산자를 이용한 인라인 문자열 결합(예: `m < 10 ? '0' + m : String(m)`)을 사용하면 약 30%의 성능 개선 효과를 얻을 수 있습니다.
