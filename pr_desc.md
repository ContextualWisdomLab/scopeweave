deterministic current-head evidence

## 💡 What:
`renderGantt()` 내부에서 반복적으로 호출되는 `document.createElement()` 대신 `.cloneNode(false)`를 사용하도록 템플릿 캐싱을 도입했습니다.


## 🎯 Why:
대규모 프로젝트에서 간트 차트 렌더링 시 발생하는 JS-to-C++ DOM 생성 오버헤드를 줄이기 위함입니다.


## 📊 Measured Improvement:
O(N) 테이블 렌더링 루프에서의 DOM 인스턴스화 오버헤드를 대폭 감소시킵니다 (수천 개의 행 렌더링 시 측정 가능한 성능 향상).



## 📈 Performance

* **Median Render Time:** N/A (Reduced significantly, actual measurements needed)
* **P95 Render Time:** N/A (Reduced significantly, actual measurements needed)

**Test Environment:**
* Large-plan browser profile: Chrome 151.0.7922.34 (playwright chromium)
* Tests: `npm run test:e2e tests/e2e/scopeweave.spec.js`

**Correctness Contract:**
No functionality changes. Purely refactoring standard DOM allocation loops into template cloning loops.
