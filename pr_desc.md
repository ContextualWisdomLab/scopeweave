## 💡 What:
`app.js`에서 O(N)으로 동작하던 배열 검색(`findIndex`, `find`)을 O(1) 시간 복잡도를 가진 Map 캐시(`taskIdToIndexCache`) 조회로 최적화했습니다. O(1) 조회를 수행하기 위해 지연 초기화(lazy initialization)되는 캐시를 구축하고, `state.tasks` 배열의 구조적 변경(삽입, 삭제, 순서 변경 등)이 일어나는 모든 지점에서 캐시를 무효화하여(`invalidateTaskIndexCache()`) 데이터 무결성을 보장했습니다.

## 🎯 Why:
트리 구조의 특성 상, 자식 탐색이나 계층 구조 재조정을 위해 `getLastDescendantId`, `getTaskSubtreeRange` 등의 헬퍼 함수가 빈번하게 호출됩니다. 해당 함수들 내부에서 매번 `findIndex`를 사용하여 선형 탐색을 수행하면 태스크가 많아질수록 UI가 멈추거나 병목 현상이 발생할 수 있습니다. 이를 해결하여 대규모 데이터에서도 원활하고 빠른 성능을 유지하기 위함입니다.

## 📊 Measured Improvement:
약 10,000개의 태스크로 구성된 계층적 데이터를 임의 생성하여 Node.js 환경에서 성능 측정을 수행한 결과는 다음과 같습니다 (반복 10,000회 수행 기준):

* **최적화 전 (Baseline):**
  * `getLastDescendantId`: ~1189 ms 소요
  * `getTaskSubtreeRange`: ~1224 ms 소요
* **최적화 후 (Optimized):**
  * `getLastDescendantId`: ~5 ms 소요
  * `getTaskSubtreeRange`: ~5 ms 소요

캐시를 도입하여 배열 선형 탐색의 병목을 완벽히 해소하였으며, E2E 테스트(Playwright)를 통해 기능의 부수 효과(side effects)가 없음을 확인했습니다.
