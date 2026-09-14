## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-14 - String.padStart vs 삼항 연산자 문자열 결합 성능 비교
**Learning:** `String(x).padStart(2, '0')` 방식은 새로운 문자열 객체 할당과 함수 호출 오버헤드를 발생시킵니다. 특히 `formatDateInput` 같은 렌더링 루프 내 날짜 포맷터와 같이 자주 호출되는 함수에서는 이러한 오버헤드가 누적됩니다.
**Action:** 성능에 민감한 핫 패스에서는 `x < 10 ? '0' + x : x` 형태의 인라인 삼항 연산자 문자열 결합을 사용하여 JS-to-C++ 할당 오버헤드를 줄여야 합니다.
