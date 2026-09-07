## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
**Action:** 자주 호출되는 날짜 포맷터에서 할당을 최소화하려면 인라인 삼항 연산(예: `month < 10 ? '0' + month : month`)을 사용해야 합니다.
## 2026-07-12 - 채워진 문자열 숫자에 대한 인라인 삼항 연결
**Learning:** 날짜 포맷터와 같이 자주 호출되는 핫 루프 내부에서 `String.prototype.padStart()`를 사용하면 불필요한 문자열 할당과 JavaScript-to-C++ 브리지 오버헤드가 발생하여 성능이 저하될 수 있습니다.
**Action:** 자주 호출되는 날짜 포맷터에서 할당을 최소화하려면 인라인 삼항 연산(예: `month < 10 ? '0' + month : month`)을 사용해야 합니다.
