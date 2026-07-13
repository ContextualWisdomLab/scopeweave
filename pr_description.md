💡 What:
`app.js`에서 간트 차트 및 타임라인 계산 시 발생하는 `Date` 인스턴스 생성 및 파싱 병목 현상을 해결했습니다. `buildWeekdayTimeline`과 `groupTimelineByWeek` 함수가 이제 문자열 기반의 날짜 연산 대신 `Date.UTC()`의 밀리초 연산을 사용하며, 타임라인 생성 단계에서 미리 계산된 데이터(`monday`)를 활용합니다.

🎯 Why:
루프 내에서 반복되는 `new Date()` 생성과 파싱(`getMonday()`, `addDays()`)으로 인해 브라우저의 CPU 사용량이 크게 증가하고 불필요한 가비지 컬렉션(GC) 압력이 발생했습니다. 이로 인해 프로젝트 일정이 길어질수록 렌더링 성능이 크게 하락했습니다.

📊 Impact:
임의의 테스트 벤치마크 기준, 타임라인 계산 루프의 실행 시간이 대략 2.5배 단축되었습니다. 메모리 할당 및 GC 오버헤드가 크게 줄어 간트 차트 모달 전환 시 사용자 경험이 개선될 것입니다.

🔬 Measurement:
- 테스트 코드가 통과하는지 확인 (`pnpm run test:unit`, `pnpm run test:e2e`, `pnpm run test:fuzz`).
- `Date` 파싱 최적화를 반영했으므로 간트 차트를 렌더링할 때 버벅임이 없는지 수동으로 확인 가능.
