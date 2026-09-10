# Product–technical gap baseline

## Authentication discrepancy resistance

ScopeWeave의 `POST /api/auth/login`은 존재하지 않는 사용자에서 비밀번호 검증을 생략하던 빠른 실패 경로를 제거하는 방향으로 변경 중이다. PR #688의 현재 구현은 사용자가 없더라도 동일한 scrypt 검증 함수를 더미 해시에 대해 호출하고, 성공 여부와 관계없이 실패 응답은 `401 {"error":"invalid credentials"}`로 유지한다. 비문자열 password는 기존 API 계약대로 인증에 실패해야 하며, 객체·배열을 문자열로 암묵 변환해 인증 입력으로 받아들이지 않는다.

이 조치는 사용자 존재 여부에 따른 큰 계산 경로 차이를 줄이는 defense-in-depth다. 데이터베이스 조회, 스케줄링, 네트워크 지연까지 포함한 응답 시간이 상수라고 주장하지 않으며, 실제 원격 사용자 열거가 재현되었다거나 HIGH severity가 입증되었다고도 간주하지 않는다. OWASP는 인증 실패에서 사용자 존재 여부에 따른 메시지·HTTP 응답·처리 시간의 discrepancy factor를 줄이고 자동화 공격에 대한 throttling을 병행하도록 권고한다.

### Acceptance

- 존재하는 사용자+오답과 존재하지 않는 사용자+임의 비밀번호가 동일한 실패 status와 generic body 계약을 유지한다.
- 두 경로 모두 scrypt password verification 경계를 통과하며 unknown-user quick exit을 다시 도입하지 않는다.
- string이 아닌 password는 401로 실패하고 유효 password로 coercion되지 않는다.
- 기존 IP 기반 request limiter가 로그인 경로에도 적용되는지 regression으로 보존한다. 필요하면 account-aware throttling은 별도 설계로 다룬다.
- timing 효과를 보안 성능으로 주장하려면 동일 host/runtime에서 충분한 반복 표본과 분포를 수집하고, 네트워크·warm-up·DB cache를 통제한 뒤 valid/invalid-user latency 분포와 effect size를 보고한다. 단일 평균이나 synthetic sleep으로 acceptance를 만들지 않는다.
- Security Scan, SAST, CodeQL, API/E2E가 동일 exact head에서 GREEN이어야 한다.

### Traceability

- Code: `server/app.mjs` login boundary, `server/auth.mjs` scrypt verification.
- Regression: `tests/api/smoke.mjs`, `tests/api/ratelimit.test.mjs`.
- Change: PR #688, base `develop@2c328875e00e86537df3e965170be80532571cad`.
- Reference: OWASP Foundation. (n.d.). *Authentication Cheat Sheet*. OWASP Cheat Sheet Series. Retrieved September 10, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
