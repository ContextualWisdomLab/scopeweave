const syncButton = document.getElementById('connect-json-sync');
const taskTableBody = document.getElementById('task-table-body');

const LOADING_TITLE = '프로젝트 데이터를 불러오는 중입니다.';
const UNSUPPORTED_TITLE = '이 브라우저는 wbs.json 직접 저장 연결을 지원하지 않습니다.';

/**
 * Keep direct wbs.json writes fail-closed until the planner has rendered its
 * hydrated state. The table body always receives either task rows or the empty
 * state row from renderAll(), so its first rendered child is the bootstrap
 * completion signal for both populated and intentionally empty projects.
 */
function updateJsonSyncAvailability() {
  const bootstrapRendered = taskTableBody.childElementCount > 0;
  const pickerSupported = typeof window.showSaveFilePicker === 'function';
  const ready = bootstrapRendered && pickerSupported;

  syncButton.disabled = !ready;
  if (ready) {
    syncButton.removeAttribute('aria-disabled');
    syncButton.title = '';
    return;
  }

  syncButton.setAttribute('aria-disabled', 'true');
  syncButton.title = bootstrapRendered ? UNSUPPORTED_TITLE : LOADING_TITLE;
}

updateJsonSyncAvailability();

const bootstrapObserver = new MutationObserver(() => {
  updateJsonSyncAvailability();
  if (taskTableBody.childElementCount > 0) {
    bootstrapObserver.disconnect();
  }
});

bootstrapObserver.observe(taskTableBody, { childList: true });
