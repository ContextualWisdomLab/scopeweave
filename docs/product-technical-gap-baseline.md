# Product–technical gap baseline

## Authentication discrepancy resistance

ScopeWeave의 `POST /api/auth/login`은 사용자 존재 여부와 입력 형식에 따라 인증 실패 경계가 달라지지 않아야 한다. 현재 수리 lane은 존재하지 않는 사용자에서도 실제 비밀번호 검증과 같은 scrypt 경계를 더미 해시에 대해 한 번 통과시키고, 실패 응답을 `401 {"error":"invalid credentials"}`로 유지한다. 이 조치는 계정 존재 여부에 따른 큰 계산 경로 차이를 줄이는 방어 조치이지, 데이터베이스 조회·런타임 스케줄링·네트워크까지 포함한 전체 요청의 constant-time 동작을 보장한다는 뜻은 아니다.

JSON 입력도 같은 실패 계약을 지켜야 한다. `email` 객체나 배열은 SQLite bind 값으로 직접 전달하지 않고 조회 후보에서 fail-closed 문자열로 정규화한다. 비문자열 `password` 역시 인증 입력으로 암묵 변환하지 않고 동일한 401 경계에서 끝나야 한다. 이 경계는 malformed credential이 내부 바인딩·암호화 예외나 5xx로 빠지는 일을 막는다.

### Acceptance

- 존재하는 사용자+오답과 존재하지 않는 사용자+동일 형식 비밀번호가 같은 401 status/body를 노출한다.
- 두 경로 모두 같은 scrypt password-verification cost class를 한 번 수행하며 unknown-user quick exit을 다시 도입하지 않는다.
- 객체·배열 `email`과 비문자열 `password`는 예외나 5xx 없이 정확히 generic 401로 실패한다.
- 유효한 문자열 email/password 로그인 의미는 바뀌지 않는다.
- 기존 로그인 rate limit과 감사·세션 계약을 약화시키지 않는다.
- timing 효과를 수치로 주장하려면 동일 host/runtime에서 warm-up을 분리하고 충분한 반복 표본·분포·분산·effect size를 보고한다. 단일 평균, synthetic sleep 또는 임의 임계값은 acceptance 근거가 아니다.
- 보안 dependency는 인증 lane에 복사하지 않는다. Hono security floor는 canonical dependency owner #687이 protected branch에 통합한 뒤 ordinary non-force restack으로 상속한다.
- API/coverage/Security/SAST/Fuzz/CodeQL 및 독립 current-head review가 하나의 변경되지 않은 exact generation에서 통과해야 한다.

### Traceability

- Code: `server/app.mjs` login boundary, `server/auth.mjs` scrypt verification.
- Regression: `tests/api/login-input-boundary.test.mjs`, `tests/api/login-enumeration-contract.test.mjs`, 기존 `tests/api/ratelimit.test.mjs`.
- Current consolidation: PR #694. PR #692의 known/unknown failure-equivalence regression과 PR #688의 product-gap evidence를 현재 lane이 승계한다.
- Dependency prerequisite: PR #687, Hono 4.13.0 → 4.13.7.
- Reference: OWASP Foundation. (n.d.). *Authentication Cheat Sheet*. OWASP Cheat Sheet Series. https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
