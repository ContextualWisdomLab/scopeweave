## 2026-07-09 - 렌더링 사이클 내 O(N) 루프 제거 및 DOM 인스턴스화 최적화
**Learning:** 렌더링 사이클(예: `renderAll`) 내부에서 매번 전체 작업을 스캔하는 O(N) 반복문을 사용하면 텍스트 입력과 같은 빈번한 이벤트 발생 시 심각한 성능 병목 현상(UI 멈춤)이 발생합니다. 또한, 매 행마다 20회씩 `document.createElement`를 호출하면 C++ DOM 바인딩 오버헤드가 발생합니다.
**Action:** 순차적 색상 할당과 같은 전역 상태 매핑은 모듈 레벨의 영구적(persistent) 지연 초기화(lazy initialization) O(1) Map 구조로 분리하고, 자주 생성되는 DOM 노드(`td`, `span`, `button`)는 미리 생성된 템플릿의 `.cloneNode(false)`를 활용하여 반복 생성 비용을 최소화해야 합니다.
## 2026-07-10 - Expanded template caching for repeated DOM allocations
**Learning:** Even small DOM elements like warning badges, action buttons, and tree cell containers contribute to JS-to-C++ allocation overhead when created millions of times in O(N) paths.
**Action:** Extend template caching (`.cloneNode(true/false)`) to all frequently instantiated DOM fragments in rendering loops, not just table cells.
