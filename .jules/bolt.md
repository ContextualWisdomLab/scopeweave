## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-12 - Inline ternary concatenation over String.padStart()
**Learning:** Using `String.padStart()` inside highly frequent hot loops (like date formatting during rendering) results in measurable JS-to-C++ overhead and unnecessary string allocations.
**Action:** Prefer using inline ternary string concatenations (e.g., `m < 10 ? '0' + m : m`) over `padStart()` for simple padding operations in performance-critical execution paths.
## 2026-07-12 - 핵심 JS 자산에 대한 리소스 프리로드 추가
**Learning:** 애플리케이션의 핵심 자산인 `analytics.js`와 `cloud-sync.js`에 대해 `<link rel="modulepreload">`가 누락되어 병목 현상을 유발하고 테스트 안정성에 영향을 미침.
**Action:** 핵심 모듈에 대해 모듈프리로드를 설정하여 네트워크 워터폴(Network Waterfall)을 방지하고 초기 로드 시간을 향상시킴.
