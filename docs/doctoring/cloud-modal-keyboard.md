# 클라우드 모달 키보드 계약

## 문제와 경계

ScopeWeave의 클라우드 로그인·공유·보고·대시보드·스프린트·산출물·코멘트·검색·기준선·팀 모달 닫기 버튼은 `aria-keyshortcuts="Escape"`를 노출합니다. WAI-ARIA는 `aria-keyshortcuts`를 브라우저가 자동 실행하는 동작으로 정의하지 않으며, 작성자가 실제 keyboard event를 처리해야 한다고 명시합니다. 따라서 속성만 추가한 상태는 assistive technology에 존재하지 않는 shortcut을 알리는 불일치입니다.

이 수리는 `cloud-modal-keyboard.js`에서 위 클라우드 모달만 소유합니다. `#gantt-modal`과 inline editor의 Escape 처리는 기존 `app.js` 소유권을 유지하며, 클라우드 모달이 열려 있을 때 한 번의 Escape가 두 UI surface를 동시에 닫지 않도록 event propagation을 중단합니다.

## 선택한 동작

- 열린 클라우드 모달에서 Escape를 누르면 기존 close button의 `click()` 경로를 호출합니다. 닫기 상태를 별도로 복제하지 않습니다.
- 모달이 focus를 받기 전의 invoking control을 기억하고, 모달이 닫힌 뒤 그 element가 아직 DOM에 존재하면 focus를 되돌립니다.
- 동적으로 생성되는 클라우드 모달이 열린 뒤 focus가 여전히 바깥에 있으면 첫 focusable element로 이동합니다. 로그인 모달처럼 owner가 이미 적절한 input에 focus를 둔 경우에는 덮어쓰지 않습니다.
- Tab/Shift+Tab은 열린 클라우드 모달의 visible focusable element 사이에서 순환합니다. Gantt/editor의 keyboard authority는 건드리지 않습니다.
- pointer로 기존 close button이나 backdrop을 누르는 경로도 그대로 사용하며 동일한 focus-return contract를 적용합니다.
- modal business state, API 호출, 저장·인증 semantics는 변경하지 않습니다.

## 검증 계약

`tests/e2e/cloud-modal-shortcut.spec.js`는 실제 로그인 모달에서 `aria-keyshortcuts="Escape"`, 기존 이메일 initial focus, Tab/Shift+Tab focus containment, Escape close, invoking button focus restoration, close button과 backdrop pointer dismissal을 검증합니다. API 없이 정적 Playwright 환경에서 동적 모달 registration 경로도 별도로 생성해 opening focus, Tab containment, single-Escape dismissal을 검증합니다. 이 두 번째 fixture는 클라우드 API 기능 검증이 아니라 동적 DOM lifecycle을 소유하는 keyboard controller의 회귀 계약입니다.

Hosted browser evidence가 exact head에서 실행되기 전까지 source/test 정합성만 GREEN으로 취급하며 제품 완료나 assistive-technology 호환성을 과장하지 않습니다. 실제 screen-reader/browser 조합, 터치·모바일 뷰포트, 모든 인증 후 동적 모달의 buyer-path 실행은 별도 acceptance 대상입니다.

## 표준 근거

WAI-ARIA 1.3 Working Draft의 `aria-keyshortcuts`는 작성자가 구현한 shortcut을 노출하는 속성이며 user agent가 해당 속성 때문에 keyboard behavior를 바꾸지 않는다고 명시합니다. WAI-ARIA Authoring Practices Guide의 Modal Dialog Pattern은 modal open 시 focus를 내부로 이동하고 Tab/Shift+Tab을 dialog 내부에 유지하며, Escape로 닫고 닫힌 뒤 통상 invoking element로 focus를 돌려보내도록 설명합니다. 본 구현은 이 두 계약에 맞추되, WAI-ARIA 1.3이 Working Draft라는 상태를 그대로 기록합니다.

### References

World Wide Web Consortium. (2026, June 4). *Accessible Rich Internet Applications (WAI-ARIA) 1.3* (W3C Working Draft). https://www.w3.org/TR/2026/WD-wai-aria-1.3-20260604/

World Wide Web Consortium. (n.d.). *Dialog (modal) pattern*. WAI-ARIA Authoring Practices Guide. Retrieved September 5, 2026, from https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/

World Wide Web Consortium. (2023, June 6). *Accessible Rich Internet Applications (WAI-ARIA) 1.2* (W3C Recommendation). https://www.w3.org/TR/wai-aria-1.2/
