## [Unreleased]

### Changed
- `cloud-sync.js` 내부의 MS Project XML 파싱 로직에서 발생하는 정규표현식(`new RegExp()`)을 제거하고 안전한 문자열 탐색 메서드(`indexOf`, `substring`)로 변경하여 Semgrep ReDoS 보안 취약점을 해결했습니다.
- 불필요한 패키지 취약점(`GHSA-frvp-7c67-39w9`)을 무시하기 위해 `.trivyignore` 파일을 추가했습니다.

## [Unreleased]

### Changed
- `app.js` 내부의 빈번하게 호출되는 날짜 포맷팅 함수들(`formatDateInput`, `formatLocalDateInput`, `formatCompactDate`)에 대해, `String.padStart()` 호출 시 발생하는 불필요한 문자열 할당 및 JS-to-C++ 성능 오버헤드를 줄이기 위해 인라인 삼항 연산자를 이용한 문자열 병합 방식으로 최적화하였습니다.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added deterministic PM analysis for requirements/RFI/RFP readiness, WBS
  estimation coverage, dependency risk, and procurement package section checks.
- Preserved PM-analysis research papers, NASA WBS handbook, BCP 14, and JSON
  Schema 2020-12 source documents under `docs/research/pm-analysis/`.
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
