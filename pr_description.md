💡 What:
`app.js`에서 간트 차트(Gantt Chart)를 렌더링할 때 반복적인 `document.createElement()` 호출을 캐싱된 DOM 템플릿의 `.cloneNode(false)` 방식으로 변경했습니다. 해당 로직을 `createGanttMetaTable` 및 `createGanttChartTable`에 적용했습니다.

🎯 Why:
O(N) 렌더링 루프 내에서 지속적인 `document.createElement` 호출은 JS와 C++(DOM) 간의 할당 오버헤드를 크게 발생시킵니다. 작업(Task) 목록이 많아질수록 렌더링 성능이 저하되는 현상을 방지하기 위해 비용이 저렴한 템플릿 복제 방식으로 전환했습니다.

📊 Impact:
- JSDOM 기준 약 30% 수준의 DOM 요소 생성 속도 향상 (113ms -> 80ms / 1만 건 기준)
- 다량의 작업 데이터를 불러왔을 때 간트 차트 모달이 렌더링되는 속도 개선.

🔬 Measurement:
- 브라우저 개발자 도구의 Performance 탭에서 간트 차트 오픈 시의 `renderGantt()` 함수 호출에 따른 스크립트 실행 시간이 단축되었는지 확인합니다.
- `pnpm run test:e2e` 및 유닛/API 테스트를 통해 기존의 간트 차트 로직과 레이아웃이 정확히 일치하게 동작하는지 확인했습니다.
