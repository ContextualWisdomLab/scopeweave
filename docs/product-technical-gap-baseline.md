# ScopeWeave 제품·기술 Gap Baseline

> 기준일: 2026-08-28  |  보호 기준 브랜치: `develop`  |  보호 기준 HEAD: `2c328875e00e86537df3e965170be80532571cad`

이 문서는 저장소의 PRD 역할을 하는 설계 문서와 README, 기술 계약,
구현·테스트·운영 게이트를 현재 파일과 실행 증거에 연결하는 기준선이다.
별도 `PRD.md`는 없으며, 제품 요구의 원문은
[`docs/plans/2026-04-20-scopeweave-design.md`](plans/2026-04-20-scopeweave-design.md)와
[`README.md`](../README.md)이다. 아래의 “완료”는 보호된 `develop`에 실제로
존재하는 것만 뜻한다. 열린 PR의 구현은 별도 제출 상태로 기록한다.

## 1. 제품 목표와 구매자

주 구매자는 일정·공정 데이터를 WBS로 관리하고 계획 대비 실적과 지연
원인을 설명해야 하는 PM과 PMO다. 제품의 핵심 가치는 다음과 같다.

1. `단계 > Activity > Task` 구조를 빠르게 편집한다.
2. 날짜·진척·선행작업에서 일정 통제 신호를 재현 가능하게 계산한다.
3. CSV와 브라우저 저장으로 별도 플랫폼에서도 계획을 회수한다.

현재 제품은 정적 브라우저 클라이언트와 선택적 Node SaaS 계층으로 나뉜다.
정적 호스팅에서 서버 파일을 덮어쓰지 않는 제약은 유지한다.

## 2. PRD/TRD 추적성

| 요구 | 보호된 `develop` 구현 증거 | 상태 |
| --- | --- | --- |
| 3단계 WBS 편집·계층 보존 | `app.js`의 단일 `state.tasks`, `renderAll()`, expand/collapse·subtree 이동 | 완료 |
| 계획/실적 진척 및 일정 통제 | `analytics.js`의 EVM, S-curve, CPM, workload | 완료 |
| 작업 검색과 계층 맥락 유지 | 현재 `develop`에는 미포함. #621의 `4c8d09d` 제출본에 구현됨 | 제출됨, 병합 대기 |
| CSV 왕복 | `exportCsv()`, CSV parser/validation, E2E·fuzz 계약 | 완료 |
| JSON seed·localStorage·선택적 파일 sync | `loadSeedTasks()`, `localStorage`, `exportJsonArray()`, File System Access API | 완료 |
| 명시적 JSON 다운로드 | 현재 `develop` UI에는 없음. #621의 `4c8d09d` 제출본에 구현됨 | 제출됨, 병합 대기 |
| 첫 방문 샘플 안내와 빈 계획 전환 | 현재 `develop`에는 미포함. #624가 #621에 병합되어 제출됨 | 제출됨, 병합 대기 |
| 정적 배포 | `pages.yml`, 상대 경로 자산, `404.html` | 구현 완료, 실제 출판 증거 필요 |
| Cloud 인증·멀티테넌시·협업 | `server/`, `cloud-sync.js`, API smoke/E2E | 코드·테스트 존재, 운영 환경 검증 필요 |

## 3. UML 및 데이터 흐름

```mermaid
classDiagram
  class ScopeWeaveState {
    +string projectName
    +string baseDate
    +Task[] tasks
    +string taskQuery
  }
  class Task {
    +string id
    +string parentId
    +number depth
    +string phase
    +string activity
    +string task
    +string plannedStartDate
    +string plannedEndDate
  }
  class AppController {
    +bootstrap()
    +renderAll()
    +persistState()
  }
  class AnalyticsBridge {
    +render(input)
    +computeCpm(tasks)
    +computeEvm(input)
  }
  class BrowserStorage {
    +load()
    +save(state)
  }
  ScopeWeaveState "1" *-- "0..*" Task
  AppController --> ScopeWeaveState
  AppController --> AnalyticsBridge
  AppController --> BrowserStorage
```

`tasks`가 유일한 원천이며 사용자 입력·파일 seed·Cloud snapshot은 이 상태로
정규화된다. 화면 갱신은 `renderAll()` 하나를 통과하고 분석은
`window.ScopeWeaveAnalytics` 경계를 통해 호출된다.

## 4. 현재 PR 및 Gap 조치 상태

이 표는 2026-08-28의 GitHub exact-head snapshot이다. Checks와 리뷰는
HEAD가 바뀌면 다시 확인해야 한다.

| ID | Gap / 고객 영향 | 현재 제출 상태 | 조치 |
| --- | --- | --- | --- |
| G-01 | 큰 WBS에서 작업 위치를 찾는 비용 | #621 `4c8d09d`, `develop` 병합 대기 | 작업·담당자·산출물 등 필드 검색과 상위 계층 표시 |
| G-02 | 정적 사용자가 JSON을 회수하려면 파일 API에 의존 | #621 `4c8d09d`, `develop` 병합 대기 | 브라우저 JSON 다운로드와 계획 필드 보존 |
| G-03 | 첫 방문자가 seed와 실제 계획을 혼동 | #624 `69eff955`가 #621에 병합됨, `develop` 병합 대기 | 샘플 안내, 숨김, 확인 가능한 빈 계획 전환 |
| G-04 | 핵심 상태의 시각 회귀 증거 부족 | 미해결 | 실제 브라우저 screenshot과 WCAG 2.2 점검을 릴리스 증거에 포함 |
| G-05 | PR 큐가 provider 실패와 승인 부재로 정지 | #495/#621/#625/#628 OpenCode current verdict 부재; #588 Strix provider 실패; #610 `3bb2bd9` Checks 재실행 중; qualifying approval 없음 | 게이트를 약화하지 않고 로그·artifact·exact HEAD 재검증 |

### Exact-head queue evidence

- #621: `develop@2c328875` 대상
  `4c8d09d17024202a1f5236ef62b31a8b5d9480c1`. CSV 성공 import 시 stale 검색어를
  초기화하고, 첫 방문 seed 탐색 중 progress/order 변경이 sample을 영속화하지 않으며,
  빠른 검색 입력의 전체 재렌더를 디바운스하는 현재 제출본이다.
- #610: `3bb2bd95905d590fe3d1d0d9a8fc6c6ec133c04a` (base
  `develop@2c328875`). 이전 exact head의 Cloud E2E가 JSON sync에서 텍스트
  `predecessors`/`sprint`의 `0`·`false`를 보존하는 결함을 검출했고, 이를
  `task.predecessors || ''` 및 `task.sprint || ''`로 수정했다. 현재 head의
  replacement Checks는 재실행 중이며, qualifying approval은 없다.
- #601: `98f4354733c68c9f361e516f86ba2d95e97af20e`. 날짜 formatter benchmark는
  protected base 대비 46.79% 개선과 checksum `118184592`를 기록했으나 Strix
  provider/backend 실패와 승인 부재로 병합하지 않았다.
- #515: `develop@2c328875` 대상 `36c11dd0bf907569184d7d73172b675d21bd0ff1`.
  Phase → Activity → Task → Duty 도메인 검증과 투영은 로컬·hosted 전체 적용
  테스트를 통과했지만 `REVIEW_REQUIRED`라 병합하지 않았다.
- #623: stacked base `refactor/schema-migration-ledger-433@9f2e6818` 대상
  `81072df8f4dd2e2df269710eb7cc852312ff7543`, draft 상태. canonical SQLite
  rename의 31개 schema/migration 테스트는 통과했지만 독립 병합 근거가 없다.
- #552: `develop@2c328875` 대상 `92487d1f9e5215cd4b7302275c23393596799ba3`,
  draft 상태. 일반 hosted 게이트는 통과하고 Strix는 취약점 0건을 출력한 뒤
  provider 장애와 authoritative report 부재로 fail-closed 되었다.
- #588: `develop@2c328875` 대상 `bc60476829ec98f37d83977a9432b79ba0b3c0d6`.
  outbound webhook SSRF 단일 수정 경로로서 encoded IP, IPv4/IPv6 special-use
  주소, DNS rebinding, pinned connection, legacy destination migration을 다룬다.
  일반 hosted 게이트는 통과했지만 Strix provider 실패와 qualifying approval
  부재로 병합하지 않았다.
- #628: `develop@2c328875` 대상 `7d27ff23a3eac6548b904f91f2282f0efcc5c5a5`.
  비상호작용 tooltip의 keyboard focus, semantic role, focus-visible 표시를
  추가했고 단독 E2E 75개가 통과했다. 현재 base의 modulepreload 누락으로
  기존 static E2E 1개가 실패하며, OpenCode current-head verdict 부재와
  qualifying approval 없음으로 병합하지 않았다.
- #495: `develop@2c328875` 대상 `9cc7ecc204dafe3dafcb78b605455beb07bbce3b`.
  정적 shell의 `cloud-sync.js`·`analytics.js` modulepreload를 제공하는
  제출본이다. #628에서 확인한 기존 E2E 실패의 별도 소유 경로이며, OpenCode/
  Strix 게이트와 qualifying approval을 재확인해야 한다. 로컬 5,000행
  production benchmark는 180초 제한에서 interaction probe가 종료되지 않아
  hosted 성능 증거로 대체하지 않았다.
- #626: `d0141077d3bb790786520efa3d115d4dd2ce70bf`는 #508의
  `computeTaskMetrics` 최적화와 중복되어 종료했다. #627:
  `c91715a4ad4f8865e7e6a90ffc51fdb8b16fd360`은 문자열 필터만으로는
  encoded IP·DNS rebinding을 막지 못해 종료하고, 보안 수정은 #588에
  단일화했다.
- #624: `69eff955bc16295a6d82b72174b25d8ec94345c1`은 base
  `feat/wbs-search-context`에 normal squash merge되어 단일 squash commit
  `5f8a3d7759aef628f4bcf06f3780c53737ca2a53`가 되었다.

## 5. 품질·보안 기준선

- 런타임 의존성은 브라우저 native API와 현재 서버의 최소 의존성만 사용한다.
- `app.js`는 `new Function` 테스트 계약 때문에 top-level ESM import/export를
  사용하지 않는다.
- 입력은 신뢰 경계에서 길이·날짜·CSV 수식·JSON prototype pollution을 검증하고,
  동적 HTML 삽입 대신 `textContent`를 사용한다.
- 접근성은 레이블, landmark, keyboard focus, live status, disabled 상태,
  reduced motion을 최소 기준으로 삼는다.
- 검증 명령은 `npm run test:unit`, `npm run test:api`, `npm run test:e2e`,
  `python3 -m pytest tests/config`, `npm run fuzz`다.
- 현재 exact-head 제출본의 로컬 증거는 PR별로 분리하며, predecessor·synthetic
  merge·pending·skipped·provider-failed evidence는 통과로 승격하지 않는다.

## 6. 표준·연구 근거 (APA 7th)

국제표준화기구. (2020). *ISO 21502:2020: Project, programme and portfolio
management—Guidance on project management*. https://www.iso.org/standard/74947.html

국제표준화기구. (2018). *ISO 21511:2018: Work breakdown structures for
project and programme management*. https://www.iso.org/standard/69702.html

국제표준화기구. (2026). *ISO 21508:2026: Project, programme and portfolio
management—Earned value management*. https://www.iso.org/standard/87899.html

World Wide Web Consortium. (2024). *Web Content Accessibility Guidelines
(WCAG) 2.2*. https://www.w3.org/TR/WCAG22/

Souppaya, M., Scarfone, K., & Dodson, D. (2022). *Secure software development
framework (SSDF) version 1.1: Recommendations for mitigating the risk of
software vulnerabilities* (NIST Special Publication 800-218). National Institute
of Standards and Technology. https://doi.org/10.6028/NIST.SP.800-218

상세한 PM 분석 연구·표준 매핑은
[`docs/research/pm-analysis/README.md`](research/pm-analysis/README.md), 설계 결정은
[`docs/plans/2026-04-20-scopeweave-design.md`](plans/2026-04-20-scopeweave-design.md)에
보존한다.
