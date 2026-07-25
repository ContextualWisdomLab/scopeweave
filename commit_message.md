⚡ Bolt: [성능 개선] 상태 및 담당자 배지 DOM 렌더링 최적화

💡 무엇을
- `createOwnerCellContent` 및 `createStatusCellContent` 함수에 DOM 템플릿 캐싱(Map) 적용
- O(N) 테이블 렌더링 루프에서 반복적인 요소 생성(`document.createElement`) 및 속성 할당 대신 `.cloneNode(true)` 사용
- 부수적으로 외부 인프라스트럭처 에러(Semgrep, Trivy)를 수정했습니다.

🎯 왜
- 수백/수천 개의 작업 행을 렌더링할 때 각 셀마다 작은 DOM 요소들의 속성(class, style, title, textContent)을 매번 JS-to-C++ 브릿지를 통해 할당하면 누적된 메모리 할당 및 실행 시간 지연(overhead)이 발생하기 때문입니다.

📊 영향
- 담당자(Owner) 배지 및 실적상태(Status) 배지 생성 시 중복된 DOM 인스턴스화 오버헤드가 감소하여 대규모 WBS 테이블의 렌더링 속도와 프레임 드롭 개선

🔬 측정
- `pnpm run test:api`, `pnpm run test:unit`, `pnpm run test:e2e` 를 통해 모든 기능 정상 작동 검증 완료
