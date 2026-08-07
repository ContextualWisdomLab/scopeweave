# 변경 사항

## [1.0.0] - 2024-05-24

### 최적화
- `formatDateInput`, `formatLocalDateInput`, `formatCompactDate` 함수에서 `String.padStart()` 대신 인라인 삼항 연산자를 사용하도록 최적화하여 JS-to-C++ 오버헤드와 불필요한 문자열 할당을 제거했습니다.

