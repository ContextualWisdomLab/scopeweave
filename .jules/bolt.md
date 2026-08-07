## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-07 - computeTaskMetrics 최적화
**Learning:** Map 캐싱과 reduce/forEach 배열 메서드는 대규모 태스크 렌더링 시 심각한 가비지 컬렉션 및 성능 병목을 유발합니다. Float64Array와 기본 for 루프를 사용하면 계산 속도를 50% 이상 단축할 수 있습니다.
**Action:** 수만 개의 요소를 반복 처리하며 임시 데이터를 저장해야 하는 렌더링 루프에서는 O(N) 크기의 Map 할당을 피하고 Float64Array와 같은 Typed Array와 일반 for 루프를 사용합니다.
