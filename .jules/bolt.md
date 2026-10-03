## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-10-02 - 중요 스크립트에 대한 modulepreload 링크 추가
**Learning:** `analytics.js`와 `cloud-sync.js` 같은 중요한 ES 모듈에 대해 `<link rel="modulepreload">`를 사용하면 초기 발견 및 병렬 다운로드가 가능해져, 폭포수 요청 체인을 방지하고 time-to-interactive를 단축시킬 수 있습니다.
**Action:** 메인 HTML 문서의 `<head>` 내에 `type="module"`로 로드되는 모든 스크립트에 대해 항상 `<link rel="modulepreload">`를 포함하도록 합니다.
