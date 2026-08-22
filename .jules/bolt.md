## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-22 - Array reduce/forEach 및 Map 오버헤드 최적화
**Learning:** computeTaskMetrics와 같이 자주 호출되는 O(N) 순회 로직에서 JS 내장 배열 메서드(reduce, forEach)와 Map을 사용하면 콜백 할당, GC, 해시 검색 오버헤드로 인해 성능 저하가 발생합니다.
**Action:** 성능이 중요한 반복문에서는 일반 for 루프와 TypedArray(Int32Array)를 사용하여 JS 엔진 오버헤드를 최소화합니다.
