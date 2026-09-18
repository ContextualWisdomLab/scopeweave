## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.

## 2024-05-24 - [성능 개선] 객체 속성 접근 성능 향상을 위한 Map 대체
**Learning:** 수천 개의 요소를 반복하는 루프 내에서 Map 객체의 `get` 및 `set` 메서드를 호출하는 것은 Float64Array와 같은 Typed Array를 순회하는 것보다 심각한 오버헤드를 발생시킵니다.
**Action:** 대규모 반복문에서 숫자형 데이터 캐시가 필요한 경우, Map 대신 Typed Array(Float64Array)를 인덱스 기반으로 사용하여 O(N) 순회 시 접근 비용을 최소화합니다.
