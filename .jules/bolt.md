## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-22 - hot loop에서 padStart() 사용으로 인한 성능 저하 개선
**Learning:** 빈번하게 호출되는 날짜 포맷팅 함수 등 hot loop에서 `String.prototype.padStart()`를 사용할 경우, 불필요한 문자열 객체 할당과 JS-to-C++ 오버헤드가 발생하여 성능 저하의 원인이 됩니다.
**Action:** 숫자를 패딩할 때 `String.padStart()` 대신 인라인 삼항 연산자(예: `m < 10 ? '0' + m : m`)와 문자열 연결을 사용하여 문자열 객체 할당 오버헤드를 줄입니다.
