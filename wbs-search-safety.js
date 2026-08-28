const filterInput = document.getElementById('task-filter');
const tableBody = document.getElementById('task-table-body');

const isFilterActive = () => Boolean(filterInput?.value.trim());
const isEditorOpen = () => Boolean(tableBody?.querySelector('.editor-panel'));

/**
 * Keep drag-and-drop aligned with the visible hierarchy.
 *
 * A filtered table intentionally hides siblings and descendants that do not
 * match the query. Reordering against that partial view can therefore place a
 * subtree somewhere the customer could not see. Filtered rows are made
 * non-draggable and dragstart is rejected before the planner's reorder handler
 * can mutate state.
 */
export function synchronizeFilteredDragSafety() {
  if (!tableBody) return;
  const draggable = !isFilterActive();
  tableBody.querySelectorAll('tr[data-task-id]').forEach((row) => {
    row.draggable = draggable;
  });
}

/**
 * Keep an active inline editor visible until the user saves or cancels it.
 *
 * Search changes re-render only rows that match the query. Disabling the
 * search box while an editor is open prevents a draft from disappearing from
 * the visible table even though the draft remains in memory.
 */
export function synchronizeEditorSearchSafety() {
  if (!filterInput) return;
  const editorOpen = isEditorOpen();
  filterInput.disabled = editorOpen;
  if (editorOpen) {
    filterInput.setAttribute('aria-disabled', 'true');
    filterInput.title = '편집을 완료하거나 취소한 후 검색할 수 있습니다.';
  } else {
    filterInput.removeAttribute('aria-disabled');
    filterInput.removeAttribute('title');
  }
}

function synchronizeSearchInteractions() {
  synchronizeFilteredDragSafety();
  synchronizeEditorSearchSafety();
}

if (filterInput && tableBody) {
  tableBody.addEventListener('dragstart', (event) => {
    if (!isFilterActive()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  filterInput.addEventListener('input', () => queueMicrotask(synchronizeSearchInteractions));

  const observer = new MutationObserver(synchronizeSearchInteractions);
  observer.observe(tableBody, { childList: true, subtree: true });
  synchronizeSearchInteractions();
}
