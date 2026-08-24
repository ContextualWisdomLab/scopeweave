## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2024-05-18 - String.padStart() 대신 인라인 삼항 연산자 사용 (Date Formatters)
**Learning:** 빈번하게 호출되는 날짜 포맷터와 같은 hot loop에서 `String.prototype.padStart()`를 사용하면 불필요한 문자열 객체 할당과 JS-to-C++ 오버헤드가 발생하여 성능이 저하될 수 있음을 확인했습니다.
**Action:** Date formatter 등에서 동적으로 자리수를 맞추어야 할 때는 `String.padStart()` 대신 인라인 3항 연산자 기반의 문자열 연결(예: `m < 10 ? '0' + m : '' + m`)을 사용하여 성능 저하(오버헤드)를 피해야 합니다.
