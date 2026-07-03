# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added companion dependency-review and OSV workflows so Strix
  manifest-only findings can be verified against authoritative PR-head
  checks.
- Added workflow ownership regression coverage so central review
  workflows stay inherited from `ContextualWisdomLab/.github`, not copied
  into this repository.

### Changed

- 프로젝트 이름 입력 필드에 입력 예시(placeholder)를 추가하여 사용자 편의성을 개선했습니다.
- 데이터 테이블의 반복되는 액션 버튼에 컨텍스트 정보(작업명)를 포함한 명시적인 ARIA 레이블을 추가하고, 유효성 검사 에러를 폼 필드에 연결하여 접근성을 개선했습니다.
- `createGanttBarElement`, `renderGantt`, `buildWeekdayTimeline`에서 반복적으로 호출되던 `compareDateStrings`를 직접적인 문자열 비교 연산(`>=`, `<=`)으로 교체하여 O(N*D) 복잡도의 캐시 스레싱과 정규식 검사를 방지했습니다.
- Centralized OpenCode Review, Strix Security Scan, PR Review Merge
  Scheduler, failed-check explanation, and coverage evidence ownership in
  `ContextualWisdomLab/.github`, removing repository-local workflow,
  script, and requirements copies.
- Documented Kubernetes/IaC as follow-up work rather than a current
  blocker for this static app.

## [1.0.0] - 2026-04-20

<!-- markdownlint-disable-next-line MD024 -->
### Added

- Initial ScopeWeave Planner release with tree-table editing,
  cumulative metrics, CSV import/export, and Gantt modal.
- `wbs.json` seed loading plus browser autosave and optional file sync.
- Playwright E2E coverage for add/edit hierarchy flows, delete
  confirmation, subtree drag-and-drop, and JSON sync shape.
- GitHub Pages deployment workflow and operator documentation.

## [1.0.1] - 2026-06-25
### 성능 개선 (Performance)
- 드래그 앤 드롭 동작 중 `dragover` 이벤트에서 발생하는 O(N) 작업 리스트 검색 성능 병목 문제를, O(1) 해시맵(Map) 기반의 캐싱 조회 로직으로 개선하여 큰 크기의 WBS 리스트에서의 버벅임 현상을 해결했습니다.

## [Unreleased]
### 성능 개선
- 빈 셀(empty cell) 렌더링 시 DOM 요소 생성(document.createElement) 반복 호출을 피하기 위해, 처음 생성한 DOM 템플릿을 `cloneNode(true)`로 복제하여 사용하도록 최적화했습니다. 이를 통해 빈도 수가 높은 렌더링 루프에서의 메모리 할당 및 가비지 컬렉션 부하를 줄였습니다.
