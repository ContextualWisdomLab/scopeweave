## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-09-26 - 중요 자산에 대한 리소스 사전 로드 누락
**Learning:** E2E 테스트에서 `index.html` 내의 특정 `<link rel="modulepreload">` 태그 존재 여부를 확인하는 것을 발견함. 이러한 태그들은 성능 리소스 힌트로 작용하며, 누락되면 스크립트 발견이 지연되어 성능 저하가 발생함.
**Action:** 중요한 JavaScript 자산에 대한 `modulepreload` 링크가 항상 HTML 문서의 `<head>` 내에 존재하도록 하여 로드 시간을 최적화하고 명시적인 E2E 테스트를 통과하도록 유지해야 함.
