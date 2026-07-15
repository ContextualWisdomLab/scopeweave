## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-15 - DOM 템플릿 캐싱 최적화
**Learning:** 바닐라 JS 애플리케이션의 O(N) 렌더링 루프 내에서 document.createElement()를 반복 호출하면 JS-to-C++ 할당 오버헤드로 인해 성능 저하가 발생할 수 있습니다.
**Action:** 반복적으로 생성되는 정적 UI 요소는 unattached 템플릿으로 미리 캐싱한 후, .cloneNode(true/false)를 사용하여 인스턴스화하여 성능을 개선합니다.
