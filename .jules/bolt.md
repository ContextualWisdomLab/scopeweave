## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-08-21 - 핫 패스(hot paths)에서의 문자열 패딩 오버헤드
**Learning:** 이 날짜 포맷팅 루프를 대상으로 한 Node/V8 마이크로벤치마크에서는 `String.padStart(2, '0')`를 제거한 구현의 실행 시간이 더 짧았습니다. 이 결과는 런타임/JIT에 종속적이며, 보편적인 GC 비용이나 JS-C++ 경계 전환 메커니즘을 입증하는 근거로 확장하지 않습니다.
**Action:** 현재 포맷터에는 출력 의미와 `padStart` 비사용을 고정하는 결정적 회귀 테스트를 유지하고, 다른 경로나 브라우저 런타임으로 최적화를 확대하기 전에는 해당 실행 환경에서 다시 측정합니다.
