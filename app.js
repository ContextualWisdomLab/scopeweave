const STORAGE_KEY = 'scopeweave:planner-state:v1';
const DEFAULT_PROJECT_NAME = 'ScopeWeave Planner';
const MAX_PROJECT_NAME_LENGTH = 120;
const MAX_BASE_DATE_LENGTH = 10;
const OWNER_COLORS = [
  '#3f51b5', '#8e24aa', '#d81b60', '#ef6c00', '#6d4c41',
  '#00897b', '#1e88e5', '#3949ab', '#7cb342', '#f4511e',
  '#5e35b1', '#c0ca33', '#00acc1', '#fb8c00', '#546e7a',
  '#43a047', '#e53935', '#6a1b9a', '#039be5', '#5d4037'
];

const ACTUAL_PROGRESS_OPTIONS = [
  '미착수(0%)',
  '착수(20%)',
  '진행(30%)',
  '진행(40%)',
  '진행(50%)',
  '진행(60%)',
  '진행(70%)',
  '진행(80%)',
  'PL검토(90%)',
  'PM확인(100%)'
];
let actualProgressSelectTemplate = null;

const ACTUAL_PROGRESS_MAP = Object.assign(Object.create(null), {
  '미착수(0%)': 0,
  '착수(20%)': 20,
  '진행(30%)': 30,
  '진행(40%)': 40,
  '진행(50%)': 50,
  '진행(60%)': 60,
  '진행(70%)': 70,
  '진행(80%)': 80,
  'PL검토(90%)': 90,
  'PM확인(100%)': 100
});

const EDITABLE_FIELDS = [
  'phase',
  'activity',
  'task',
  'categoryLarge',
  'categoryMedium',
  'documentName',
  'owner',
  'supportTeam',
  'plannedStartDate',
  'plannedEndDate',
  'actualProgressStatus',
  'actualStartDate',
  'actualEndDate'
];

const CSV_HEADERS = [
  '단계',
  'Activity',
  'Task',
  '대분류',
  '중분류',
  '산출물',
  '담당자',
  '지원팀',
  '진행상태',
  '계획시작일',
  '계획종료일',
  '일수',
  '계획진척률',
  '가중치',
  '가중치진척률',
  '실적진척상태',
  '실적진척률',
  '실적시작일',
  '실적종료일',
  '가중치실적진척률',
  '__id',
  '__parentId',
  '__depth'
];
const CSV_FORMULA_PREFIX_PATTERN = /^\s*[=+\-@|]/;
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const CSV_FIELD_LABELS = Object.freeze(Object.assign(Object.create(null), {
  phase: '단계',
  activity: 'Activity',
  task: 'Task',
  categoryLarge: '대분류',
  categoryMedium: '중분류',
  documentName: '산출물',
  owner: '담당자',
  supportTeam: '지원팀',
  plannedStartDate: '계획시작일',
  plannedEndDate: '계획종료일',
  actualProgressStatus: '실적진척상태',
  actualStartDate: '실적시작일',
  actualEndDate: '실적종료일'
}));

const EDITOR_FIELD_TEST_IDS = Object.freeze(Object.assign(Object.create(null), {
  phase: 'editor-phase',
  activity: 'editor-activity',
  task: 'editor-task',
  categoryLarge: 'editor-category-large',
  categoryMedium: 'editor-category-medium',
  documentName: 'editor-document-name',
  owner: 'editor-owner',
  supportTeam: 'editor-support-team',
  plannedStartDate: 'editor-planned-start',
  plannedEndDate: 'editor-planned-end',
  actualStartDate: 'editor-actual-start',
  actualEndDate: 'editor-actual-end'
}));

const LEGACY_PLANNED_END_FIELD = 'plannedEnd' + 'Ddate';

const DEFAULT_EDITOR_STATE = {
  mode: null,
  targetId: null,
  parentId: null,
  depth: 1,
  insertAfterId: null,
  draft: null,
  errors: []
};

const state = {
  projectName: DEFAULT_PROJECT_NAME,
  baseDate: formatLocalDateInput(new Date()),
  tasks: [],
  editor: { ...DEFAULT_EDITOR_STATE, errors: [] },
  jsonSyncHandle: null,
  dragTaskId: null,
  dragTaskCache: null,
  dragElement: null,
  dropTargetElement: null,
  toastTimer: null,
  previousFocus: null
};


// ⚡ Bolt: Cache task IDs to indices for O(1) lookups instead of O(N) array scans
let taskIdToIndexCache = null;

function invalidateTaskIndexCache() {
  taskIdToIndexCache = null;
}

function getTaskIndexById(taskId) {
  if (!taskIdToIndexCache) {
    taskIdToIndexCache = new Map();
    for (let i = 0; i < state.tasks.length; i++) {
      taskIdToIndexCache.set(state.tasks[i].id, i);
    }
  }
  const index = taskIdToIndexCache.get(taskId);
  return index !== undefined ? index : -1;
}

const elements = {
  projectNameInput: document.getElementById('project-name'),
  baseDateInput: document.getElementById('base-date'),
  totalDays: document.getElementById('summary-total-days'),
  plannedProgress: document.getElementById('summary-planned-progress'),
  actualProgress: document.getElementById('summary-actual-progress'),
  tableBody: document.getElementById('task-table-body'),
  addRootButton: document.getElementById('add-root-task'),
  exportCsvButton: document.getElementById('export-csv'),
  importCsvButton: document.getElementById('import-csv'),
  csvFileInput: document.getElementById('csv-file-input'),
  ganttModal: document.getElementById('gantt-modal'),
  ganttContent: document.getElementById('gantt-content'),
  openGanttButton: document.getElementById('open-gantt'),
  closeGanttButton: document.getElementById('close-gantt'),
  connectJsonSyncButton: document.getElementById('connect-json-sync'),
  syncStatus: document.getElementById('sync-status'),
  toast: document.getElementById('toast')
};

async function bootstrap() {
  bindEvents();

  if (!window.showSaveFilePicker) {
    elements.connectJsonSyncButton.setAttribute('aria-disabled', 'true');
    elements.connectJsonSyncButton.title = '이 브라우저는 wbs.json 직접 저장 연결을 지원하지 않습니다.';
  }

  const savedState = loadLocalState();
  if (savedState) {
    hydrateState(savedState);
  } else {
    const seedData = await loadSeedTasks();
    state.tasks = normalizeImportedTasks(seedData);
    invalidateTaskIndexCache();
  }

  renderAll();
}

function bindEvents() {
  const persistAndRenderMetadata = debounce(() => {
    persistState();
    renderAll();
  }, 150);
  const renderDraftValidation = debounce(renderEditorValidation, 150);
  const updateEditorDraftFromEvent = (event) => {
    const field = event.target.dataset.editorField;
    if (!field || !state.editor.draft) {
      return false;
    }
    state.editor.draft[field] = event.target.value;
    return true;
  };

  bindHeaderEvents(persistAndRenderMetadata);
  bindModalEvents();
  bindGlobalEvents();
  bindTableEvents(renderDraftValidation, updateEditorDraftFromEvent);
}

function bindHeaderEvents(persistAndRenderMetadata) {
  elements.projectNameInput.addEventListener('input', (event) => {
    const sanitized = String(event.target.value).slice(0, MAX_PROJECT_NAME_LENGTH);
    if (event.target.value !== sanitized) {
      const cursor = Math.min(event.target.selectionStart ?? sanitized.length, sanitized.length);
      event.target.value = sanitized;
      event.target.setSelectionRange(cursor, cursor);
    }
    state.projectName = sanitized.trim() || DEFAULT_PROJECT_NAME;
    persistAndRenderMetadata();
  });
  elements.projectNameInput.addEventListener('blur', persistAndRenderMetadata.flush);

  elements.baseDateInput.addEventListener('input', (event) => {
    state.baseDate = String(event.target.value).trim().slice(0, MAX_BASE_DATE_LENGTH) || formatLocalDateInput(new Date());
    persistAndRenderMetadata();
  });
  elements.baseDateInput.addEventListener('blur', persistAndRenderMetadata.flush);

  elements.addRootButton.addEventListener('click', () => openEditor({ mode: 'create', parentId: null, depth: 1, insertAfterId: getLastRootTaskId() }));
  elements.exportCsvButton.addEventListener('click', (e) => {
    if (elements.exportCsvButton.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      showToast('내보낼 작업이 없습니다. 하단의 버튼을 통해 작업을 추가해주세요.');
      return;
    }
    exportCsv();
  });
  elements.importCsvButton.addEventListener('click', () => elements.csvFileInput.click());
  elements.csvFileInput.addEventListener('change', handleCsvImport);
  elements.openGanttButton.addEventListener('click', (e) => {
    if (elements.openGanttButton.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      showToast('간트 차트로 표시할 작업이 없습니다. 작업을 먼저 추가해주세요.');
      return;
    }
    openGanttModal();
  });
  elements.closeGanttButton.addEventListener('click', closeGanttModal);
  elements.ganttModal.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') {
      closeGanttModal();
    }
  });

  elements.connectJsonSyncButton.addEventListener('click', async (e) => {
    if (elements.connectJsonSyncButton.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      showToast('이 브라우저는 wbs.json 직접 저장 연결을 지원하지 않습니다.');
      return;
    }
    await connectJsonSync();
  });
}

function bindModalEvents() {
  elements.closeGanttButton.addEventListener('click', closeGanttModal);
  elements.ganttModal.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') {
      closeGanttModal();
    }
  });
}

function bindGlobalEvents() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!elements.ganttModal.classList.contains('hidden')) {
        closeGanttModal();
      } else if (state.editor.mode) {
        closeEditor();
      }
    } else if (event.key === 'Tab' && !elements.ganttModal.classList.contains('hidden')) {
      trapGanttModalFocus(event);
    }
  });
}

function bindTableEvents(renderDraftValidation, updateEditorDraftFromEvent) {
  elements.tableBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row) {
      return;
    }

    const taskId = row.dataset.taskId;
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      if (actionButton.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        showToast(actionButton.title || '현재 사용할 수 없는 작업입니다.');
        return;
      }
      handleRowAction(actionButton.dataset.action, taskId);
      return;
    }

    if (!event.target.closest('input, select, button, label, .drag-handle')) {
      openEditor({ mode: 'edit', targetId: taskId });
    }
  });

  elements.tableBody.addEventListener('input', (event) => {
    if (updateEditorDraftFromEvent(event)) {
      renderDraftValidation();
    }
  });

  elements.tableBody.addEventListener('change', (event) => {
    if (event.target.dataset.inlineProgress) {
      handleInlineProgressChange(event);
      return;
    }
    if (updateEditorDraftFromEvent(event)) {
      renderDraftValidation.flush();
      renderEditorValidation();
    }
  });

  elements.tableBody.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-editor-form="true"]');
    if (!form) {
      return;
    }
    event.preventDefault();
    renderDraftValidation.flush();
    saveEditor();
  });

  elements.tableBody.addEventListener('dragstart', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row) {
      return;
    }

    // Cache task lookups for the drag-and-drop hot path.
    state.dragTaskCache = new Map(state.tasks.map(t => [t.id, t]));
    state.dragTaskId = row.dataset.taskId;
    state.dragElement = row;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.dragTaskId);
  });

  elements.tableBody.addEventListener('dragend', () => {
    clearDragState();
  });

  elements.tableBody.addEventListener('dragover', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row || !state.dragTaskId || row.dataset.taskId === state.dragTaskId) {
      return;
    }

    const draggedTask = (state.dragTaskCache ? state.dragTaskCache.get(state.dragTaskId) : null) || findTask(state.dragTaskId);
    const targetTask = (state.dragTaskCache ? state.dragTaskCache.get(row.dataset.taskId) : null) || findTask(row.dataset.taskId);
    if (!draggedTask || !targetTask || !canReorderWithinLevel(draggedTask, targetTask)) {
      return;
    }

    event.preventDefault();
    if (state.dropTargetElement !== row) {
      clearDropTargets();
      state.dropTargetElement = row;
      row.classList.add('drop-target');
    }
    const rect = row.getBoundingClientRect();
    row.dataset.dropPosition = event.clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
  });

  elements.tableBody.addEventListener('dragleave', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (row && state.dropTargetElement === row) {
      clearDropTargets();
    }
  });

  elements.tableBody.addEventListener('drop', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row || !state.dragTaskId) {
      return;
    }

    event.preventDefault();
    const targetTask = (state.dragTaskCache ? state.dragTaskCache.get(row.dataset.taskId) : null) || findTask(row.dataset.taskId);
    const draggedTask = (state.dragTaskCache ? state.dragTaskCache.get(state.dragTaskId) : null) || findTask(state.dragTaskId);
    if (draggedTask && targetTask && canReorderWithinLevel(draggedTask, targetTask)) {
      const rect = row.getBoundingClientRect();
      const placeAfter = event.clientY >= rect.top + rect.height / 2;
      reorderTaskWithinLevel(draggedTask.id, targetTask.id, placeAfter);
      persistState();
      renderAll();
      showToast('같은 계층 내에서 순서를 변경했습니다.');
    }
    clearDragState();
  });
}

const cachedHasChildrenSet = new Set();
function renderAll() {
  const metrics = computeTaskMetrics();

  elements.projectNameInput.value = state.projectName;
  document.title = state.projectName === DEFAULT_PROJECT_NAME ? DEFAULT_PROJECT_NAME : `${state.projectName} - ${DEFAULT_PROJECT_NAME}`;
  elements.baseDateInput.value = state.baseDate;
  elements.totalDays.textContent = `${formatNumber(metrics.totalDays)}일`;
  elements.plannedProgress.textContent = formatPercent(metrics.totalWeightedPlannedRatio * 100, 2);
  elements.actualProgress.textContent = formatPercent(metrics.totalWeightedActualRatio * 100, 2);
  elements.syncStatus.textContent = state.jsonSyncHandle ? '연결된 wbs.json 파일에 자동저장 중' : '브라우저 로컬 자동저장 사용 중';

  const ownerColorMap = createOwnerColorMap();
  const visibleTasks = getVisibleTasks();
  const rows = [];

  const hasTasks = state.tasks.length > 0;
  if (!hasTasks) {
    elements.exportCsvButton.setAttribute('aria-disabled', 'true');
    elements.openGanttButton.setAttribute('aria-disabled', 'true');
  } else {
    elements.exportCsvButton.removeAttribute('aria-disabled');
    elements.openGanttButton.removeAttribute('aria-disabled');
  }
  elements.exportCsvButton.title = hasTasks ? '' : '내보낼 작업이 없습니다. 하단의 버튼을 통해 작업을 추가해주세요.';
  elements.openGanttButton.title = hasTasks ? '' : '간트 차트로 표시할 작업이 없습니다. 작업을 먼저 추가해주세요.';

  // ⚡ Bolt: Cache parent IDs to convert O(N^2) render loop to O(N)
  cachedHasChildrenSet.clear();
  state.tasks.forEach(task => {
    if (task.parentId) cachedHasChildrenSet.add(task.parentId);
  });

  visibleTasks.forEach((task, index) => {
    const taskMetrics = metrics.byTask.get(task.id);
    const hasChildren = cachedHasChildrenSet.has(task.id);
    rows.push(renderTaskRow(task, taskMetrics, ownerColorMap, index, hasChildren));
    if (state.editor.mode && state.editor.mode === 'edit' && state.editor.targetId === task.id) {
      rows.push(renderEditorRow(task.id));
    }
    if (state.editor.mode === 'create' && state.editor.insertAfterId === task.id) {
      rows.push(renderEditorRow(task.id));
    }
  });

  if (state.editor.mode === 'create' && !state.editor.insertAfterId) {
    rows.unshift(renderEditorRow('root-create-anchor'));
  }

  if (rows.length === 0) {
    rows.push(createEmptyStateRow());
  }

  setTableBodyRows(rows);
  renderEditorValidation();
}

function setTableBodyRows(rows) {
  elements.tableBody.replaceChildren(...rows);
}

function createEmptyStateRow() {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.className = 'empty-state-cell';
  cell.colSpan = 21;

  const emptyState = document.createElement('div');
  emptyState.className = 'table-empty';

  const icon = document.createElement('div');
  icon.className = 'empty-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '📋';

  const title = document.createElement('h3');
  title.className = 'empty-title';
  title.textContent = '등록된 작업이 없습니다';

  const description = document.createElement('p');
  description.className = 'empty-desc';
  description.append(
    "하단의 '최상위 작업 추가' 버튼을 눌러 프로젝트를 시작하거나,",
    document.createElement('br'),
    "'CSV 가져오기'를 통해 기존 데이터를 불러오세요."
  );

  const actions = document.createElement('div');
  actions.className = 'empty-actions editor-actions';

  const addRootBtn = document.createElement('button');
  addRootBtn.type = 'button';
  addRootBtn.className = 'primary-button';
  addRootBtn.textContent = '최상위 작업 추가';
  addRootBtn.addEventListener('click', () => {
    openEditor({ mode: 'create', parentId: null, depth: 1, insertAfterId: getLastRootTaskId() });
  });

  const importCsvBtn = document.createElement('button');
  importCsvBtn.type = 'button';
  importCsvBtn.className = 'secondary-button';
  importCsvBtn.textContent = 'CSV 가져오기';
  importCsvBtn.addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });

  actions.append(addRootBtn, importCsvBtn);

  emptyState.append(icon, title, description, actions);
  cell.appendChild(emptyState);
  row.appendChild(cell);
  return row;
}

function createTableCell(className, content) {
  const cell = document.createElement('td');
  if (className) {
    cell.className = className;
  }
  if (content) {
    cell.appendChild(content);
  }
  return cell;
}

function renderTaskRow(task, taskMetrics, ownerColorMap, index, hasChildren) {
  const row = document.createElement('tr');
  row.className = `task-row depth-${task.depth} ${index % 2 === 1 ? 'striped-even' : ''}`;
  row.dataset.taskId = task.id;
  row.draggable = true;

  const actionCell = document.createElement('td');
  const actionStack = document.createElement('div');
  actionStack.className = 'action-stack';

  const rowEntityName = task.task || task.activity || task.phase || '작업';

  if (hasChildren) {
    const toggleButton = document.createElement('button');
    const toggleLabel = task.expanded ? '접기' : '펼치기';
    toggleButton.type = 'button';
    toggleButton.className = 'toggle-button';
    toggleButton.dataset.action = 'toggle';
    toggleButton.setAttribute('aria-label', `${toggleLabel} - ${rowEntityName}`);
    toggleButton.setAttribute('aria-expanded', String(task.expanded));
    toggleButton.title = `${toggleLabel} - ${rowEntityName}`;
    const toggleIcon = document.createElement('span');
    toggleIcon.setAttribute('aria-hidden', 'true');
    toggleIcon.textContent = task.expanded ? '▼' : '▶';
    toggleButton.appendChild(toggleIcon);
    actionStack.appendChild(toggleButton);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'toggle-placeholder';
    actionStack.appendChild(placeholder);
  }

  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.setAttribute('aria-hidden', 'true');
  dragHandle.title = '드래그하여 순서 변경';
  dragHandle.textContent = '⋮⋮';

  const isLeaf = task.depth >= 3;
  const addChildButton = createActionButton(`하위 추가 - ${rowEntityName}`, '＋', 'add-child', isLeaf ? '최대 3단계까지만 추가할 수 있습니다.' : `하위 추가 - ${rowEntityName}`);

  if (isLeaf) {
    addChildButton.setAttribute('aria-disabled', 'true');
  } else {
    addChildButton.removeAttribute('aria-disabled');
  }

  const editButton = createActionButton(`편집 - ${rowEntityName}`, '✎', 'edit', `편집 - ${rowEntityName}`);
  editButton.setAttribute('aria-haspopup', 'dialog');

  const deleteButton = createActionButton(`삭제 - ${rowEntityName}`, '🗑', 'delete', `삭제 - ${rowEntityName}`);

  actionStack.append(
    dragHandle,
    addChildButton,
    editButton,
    deleteButton
  );
  actionCell.appendChild(actionStack);
  row.appendChild(actionCell);

  row.append(
    createTableCell('', createTreeCellContent(task.phase, task.depth)),
    createTableCell('', createTextCellContent(task.activity)),
    createTableCell('', createTextCellContent(task.task)),
    createTableCell('priority-mobile', createTextCellContent(task.categoryLarge)),
    createTableCell('priority-mobile', createTextCellContent(task.categoryMedium)),
    createTableCell('priority-desktop', createTextCellContent(task.documentName)),
    createTableCell('priority-mobile', createOwnerCellContent(task.owner, ownerColorMap)),
    createTableCell('priority-desktop', createTextCellContent(task.supportTeam)),
    createTableCell('priority-mobile', createStatusCellContent(taskMetrics.progressState)),
    createTableCell('priority-mobile', createTextCellContent(task.plannedStartDate)),
    createTableCell('priority-mobile', createTextCellContent(task.plannedEndDate)),
    createTableCell('priority-desktop', createMetricText(formatNumber(taskMetrics.durationDays), 'task-duration-days')),
    createTableCell('priority-desktop', createMetricText(formatPercent(taskMetrics.plannedProgressRatio * 100, 2))),
    createTableCell('priority-desktop', createMetricText(formatDecimal(taskMetrics.weightRatio, 3), 'task-weight-ratio')),
    createTableCell('priority-desktop', createMetricText(formatPercent(taskMetrics.weightedPlannedRatio * 100, 2))),
    createTableCell('priority-mobile', createActualProgressCellContent(task, taskMetrics)),
    createTableCell('priority-desktop', createMetricText(formatPercent(taskMetrics.actualProgressRatio * 100, 2))),
    createTableCell('priority-mobile', createTextCellContent(task.actualStartDate, taskMetrics.actualDateWarning)),
    createTableCell('priority-mobile', createTextCellContent(task.actualEndDate, taskMetrics.actualDateWarning)),
    createTableCell('priority-desktop', createMetricText(formatPercent(taskMetrics.weightedActualRatio * 100, 2)))
  );

  return row;
}

function createActionButton(label, text, action, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.title = title;
  const iconSpan = document.createElement('span');
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = text;
  button.appendChild(iconSpan);
  return button;
}

function renderEditorRow(anchorId) {
  const draft = state.editor.draft || createEmptyTaskDraft();
  const depth = state.editor.depth;

  const row = document.createElement('tr');
  row.className = 'editor-row';
  row.dataset.editorAnchor = anchorId;

  const cell = document.createElement('td');
  cell.colSpan = 21;
  const panel = document.createElement('div');
  panel.className = 'editor-panel';
  const form = document.createElement('form');
  form.dataset.editorForm = 'true';
  const editorGrid = document.createElement('div');
  editorGrid.className = 'editor-grid';

  [
    renderEditorField('단계', 'phase', draft.phase, 'text', depth === 1, '예: P1000.분석단계'),
    renderEditorField('Activity', 'activity', draft.activity, 'text', depth === 2, '예: 요구사항 분석'),
    renderEditorField('Task', 'task', draft.task, 'text', depth === 3, '예: 인터뷰 진행'),
    renderEditorField('대분류', 'categoryLarge', draft.categoryLarge, 'text', false, '예: 공통'),
    renderEditorField('중분류', 'categoryMedium', draft.categoryMedium, 'text', false, '예: 기획'),
    renderEditorField('산출물', 'documentName', draft.documentName, 'text', false, '예: 요구사항정의서'),
    renderEditorField('담당자', 'owner', draft.owner, 'text', false, '예: 홍길동'),
    renderEditorField('지원팀', 'supportTeam', draft.supportTeam, 'text', false, '예: 인프라팀'),
    renderEditorField('계획시작일', 'plannedStartDate', draft.plannedStartDate, 'date'),
    renderEditorField('계획종료일', 'plannedEndDate', draft.plannedEndDate, 'date'),
    renderEditorSelectField('실적진척상태', 'actualProgressStatus', draft.actualProgressStatus, ACTUAL_PROGRESS_OPTIONS),
    renderEditorField('실적시작일', 'actualStartDate', draft.actualStartDate, 'date'),
    renderEditorField('실적종료일', 'actualEndDate', draft.actualEndDate, 'date')
  ].forEach((field) => editorGrid.appendChild(field));

  const editorActions = document.createElement('div');
  editorActions.className = 'editor-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'primary-button';
  saveButton.textContent = '저장';
  saveButton.title = '저장 (Enter)';
  saveButton.setAttribute('aria-keyshortcuts', 'Enter');
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'secondary-button';
  cancelButton.dataset.action = 'cancel-editor';
  cancelButton.textContent = '취소';
  cancelButton.title = '취소 (Esc)';
  cancelButton.setAttribute('aria-keyshortcuts', 'Escape');
  // ⚡ Bolt: Attach listener once during creation to prevent O(N) accumulation in renderEditorValidation
  cancelButton.addEventListener('click', () => closeEditor());
  const errors = document.createElement('div');
  errors.id = 'editor-errors';
  errors.className = 'validation-message';
  errors.setAttribute('aria-live', 'polite');
  errors.setAttribute('aria-atomic', 'true');
  editorActions.append(saveButton, cancelButton, errors);

  form.append(editorGrid, editorActions);
  panel.appendChild(form);
  cell.appendChild(panel);
  row.appendChild(cell);
  return row;
}

function renderEditorField(label, field, value, type = 'text', required = false, placeholder = '') {
  const labelElement = document.createElement('label');
  labelElement.className = 'editor-field';
  const fieldId = `editor-input-${field}-${Date.now()}`;
  labelElement.htmlFor = fieldId;
  const labelText = document.createElement('span');
  labelText.textContent = label;
  if (required) {
    const marker = document.createElement('span');
    marker.className = 'required-indicator';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '*';
    const srOnly = document.createElement('span');
    srOnly.className = 'sr-only';
    srOnly.textContent = '(필수)';
    labelText.append(' ', marker, srOnly);
  }
  const input = document.createElement('input');
  input.id = fieldId;
  input.setAttribute('data-testid', EDITOR_FIELD_TEST_IDS[field] || `editor-${toKebab(field)}`);
  input.dataset.editorField = field;
  input.type = type;
  if (type === 'text') {
    input.maxLength = 1000;
  }
  input.value = value || '';
  if (required) {
    input.required = true;
    input.setAttribute('aria-required', 'true');
  }
  if (placeholder) {
    input.placeholder = placeholder;
  }
  labelElement.append(labelText, input);
  return labelElement;
}

function renderEditorSelectField(label, field, value, options) {
  const labelElement = document.createElement('label');
  labelElement.className = 'editor-field';
  const fieldId = `editor-select-${field}-${Date.now()}`;
  labelElement.htmlFor = fieldId;
  const labelText = document.createElement('span');
  labelText.textContent = label;
  const select = document.createElement('select');
  select.id = fieldId;
  select.dataset.editorField = field;
  options.forEach((optionValue) => {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionValue;
    option.selected = optionValue === value;
    select.appendChild(option);
  });
  labelElement.append(labelText, select);
  return labelElement;
}

function createTreeCellContent(value, depth) {
  const treeValue = document.createElement('div');
  treeValue.className = `tree-value indent-${depth}`;
  if (value) {
    treeValue.textContent = value;
  } else {
    treeValue.appendChild(createEmptyCell());
  }
  return treeValue;
}

function createTextCellContent(value, warning = '') {
  if (!value) {
    return warning ? createWarningBadge(warning) : createEmptyCell();
  }
  if (!warning) {
    return document.createTextNode(value);
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(document.createTextNode(value));
  const validation = document.createElement('div');
  validation.className = 'validation-message';
  validation.textContent = warning;
  wrapper.appendChild(validation);
  return wrapper;
}

function createEmptyCell() {
  const emptyCell = document.createElement('span');
  emptyCell.className = 'empty-cell';

  const visibleDash = document.createElement('span');
  visibleDash.setAttribute('aria-hidden', 'true');
  visibleDash.textContent = '-';

  const srOnly = document.createElement('span');
  srOnly.className = 'sr-only';
  srOnly.textContent = '값 없음';

  emptyCell.append(visibleDash, srOnly);
  return emptyCell;
}

function createWarningBadge(warning) {
  const badge = document.createElement('span');
  badge.className = 'warning-badge';
  badge.textContent = warning;
  return badge;
}

function createOwnerCellContent(owner, ownerColorMap) {
  if (!owner) {
    return createEmptyCell();
  }
  const badge = document.createElement('span');
  badge.className = 'owner-badge';
  badge.style.background = ownerColorMap.get(owner);
  badge.textContent = owner;
  return badge;
}

function createStatusCellContent(progressState) {
  if (!progressState.label) {
    return createEmptyCell();
  }
  const badge = document.createElement('span');
  badge.className = `status-badge ${progressState.className}`;
  badge.textContent = progressState.label;
  return badge;
}

function createMetricText(value, testId = '') {
  const metric = document.createElement('span');
  metric.className = 'metric-text';
  if (testId) {
    metric.setAttribute('data-testid', testId);
  }
  metric.textContent = value;
  return metric;
}

function createActualProgressCellContent(task, taskMetrics) {
  const label = document.createElement('label');
  const fieldId = `actual-progress-${task.id}`;
  label.htmlFor = fieldId;
  const srOnly = document.createElement('span');
  srOnly.className = 'sr-only';
  const rowEntityName = task.task || task.activity || task.phase || '작업';
  srOnly.textContent = `실적진척상태 - ${rowEntityName}`;
  if (!actualProgressSelectTemplate) {
    actualProgressSelectTemplate = document.createElement('select');
    ACTUAL_PROGRESS_OPTIONS.forEach((optionValue) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue;
      actualProgressSelectTemplate.appendChild(option);
    });
  }
  const select = actualProgressSelectTemplate.cloneNode(true);
  select.id = fieldId;
  select.dataset.inlineProgress = task.id;
  select.value = task.actualProgressStatus;
  if (select.value !== task.actualProgressStatus) {
    select.value = '미착수(0%)';
  }
  label.append(srOnly, select);

  const warning = taskMetrics.plannedDateWarning || taskMetrics.actualDateWarning;
  if (warning) {
    const validation = document.createElement('div');
    validation.id = `actual-progress-error-${task.id}`;
    validation.className = 'validation-message';
    validation.textContent = warning;
    label.appendChild(validation);
    select.setAttribute('aria-invalid', 'true');
    select.setAttribute('aria-describedby', validation.id);
  }
  return label;
}

function renderEditorValidation() {
  const errors = validateDraft(state.editor.draft, state.editor.depth);
  state.editor.errors = errors;
  const errorElement = document.getElementById('editor-errors');
  if (errorElement) {
    errorElement.textContent = errors.join(' ');
  }

  const form = document.querySelector('form[data-editor-form="true"]');
  if (!form) {
    return;
  }

  const saveButton = form.querySelector('button[type="submit"]');
  if (saveButton) {
    saveButton.disabled = errors.length > 0;
    saveButton.title = errors.length > 0 ? '입력값을 올바르게 수정해야 저장할 수 있습니다.' : '저장 (Enter)';
  }

  form.querySelectorAll('input[data-editor-field]').forEach((input) => {
    const label = CSV_FIELD_LABELS[input.dataset.editorField] || input.dataset.editorField;
    const hasError = errors.some((error) => label && error.includes(label));
    if (hasError) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'editor-errors');
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  });
}

function handleInlineProgressChange(event) {
  const taskId = event.target.dataset.inlineProgress;
  const task = findTask(taskId);
  if (!task) {
    return;
  }
  task.actualProgressStatus = event.target.value;
  persistState();
  renderAll();

  // 🎨 Palette: Restore focus to the dropdown after full DOM re-render
  requestAnimationFrame(() => {
    const dropdown = document.querySelector(`[data-inline-progress="${taskId}"]`);
    if (dropdown) {
      dropdown.focus();
    }
  });
}

function handleRowAction(action, taskId) {
  const task = findTask(taskId);
  if (!task) {
    return;
  }

  if (action === 'toggle') {
    task.expanded = !task.expanded;
    persistState();
    renderAll();

    // 🎨 Palette: Restore focus to the toggle button after full DOM re-render
    requestAnimationFrame(() => {
      const toggleBtn = document.querySelector(`tr[data-task-id="${taskId}"] button[data-action="toggle"]`);
      if (toggleBtn) {
        toggleBtn.focus();
      }
    });
    return;
  }

  if (action === 'edit') {
    openEditor({ mode: 'edit', targetId: taskId });
    return;
  }

  if (action === 'add-child') {
    if (task.depth >= 3) {
      showToast('최대 3단계까지만 추가할 수 있습니다.');
      return;
    }
    task.expanded = true;
    openEditor({ mode: 'create', parentId: taskId, depth: task.depth + 1, insertAfterId: getLastDescendantId(taskId), draft: createChildDraft(task) });
    return;
  }

  if (action === 'delete') {
    if (window.confirm(`'${task.task || task.activity || task.phase || '선택한 작업'}' 항목과 모든 하위 작업을 삭제하시겠습니까?`)) {
      deleteTaskAndDescendants(taskId);
      persistState();
      renderAll();
      showToast('작업을 삭제했습니다.');
    }
    return;
  }
}

function openEditor({ mode, targetId = null, parentId = null, depth = 1, insertAfterId = null, draft = null }) {
  state.previousFocus = document.activeElement;
  if (mode === 'edit') {
    const task = findTask(targetId);
    if (!task) {
      return;
    }
    state.editor = {
      mode,
      targetId,
      parentId: task.parentId,
      depth: task.depth,
      insertAfterId: targetId,
      draft: { ...task },
      errors: []
    };
  } else {
    state.editor = {
      mode,
      targetId: null,
      parentId,
      depth,
      insertAfterId,
      draft: draft ? { ...draft } : createEmptyTaskDraft(),
      errors: []
    };
  }
  renderAll();

  // Focus the first input/select in the editor to keep keyboard users in flow
  requestAnimationFrame(() => {
    const firstInput = document.querySelector('.editor-row input:not([type="hidden"]), .editor-row select');
    if (firstInput) {
      firstInput.focus();
    }
  });
}

function closeEditor() {
  state.editor = { ...DEFAULT_EDITOR_STATE, errors: [] };
  renderAll();

  if (state.previousFocus) {
    state.previousFocus.focus();
    state.previousFocus = null;
  }
}

function saveEditor() {
  const errors = validateDraft(state.editor.draft, state.editor.depth);
  if (errors.length > 0) {
    state.editor.errors = errors;
    renderEditorValidation();
    return;
  }

  if (state.editor.mode === 'edit' && state.editor.targetId) {
    const index = getTaskIndexById(state.editor.targetId);
    if (index >= 0) {
      state.tasks[index] = {
        ...state.tasks[index],
        ...sanitizeDraft(state.editor.draft),
        depth: state.tasks[index].depth,
        parentId: state.tasks[index].parentId
      };
    }
  }

  if (state.editor.mode === 'create') {
      const newTask = {
        ...createEmptyTaskDraft(),
        ...sanitizeDraft(state.editor.draft),
        id: createId(),
        parentId: state.editor.parentId,
        depth: state.editor.depth,
        expanded: true,
        isSynthetic: false
      };
    insertTaskAfter(newTask, state.editor.insertAfterId);
  }

  closeEditor();
  persistState();
  renderAll();
  showToast('변경 내용을 저장했습니다.');
}

function createEmptyTaskDraft() {
  return {
    phase: '',
    activity: '',
    task: '',
    categoryLarge: '',
    categoryMedium: '',
    documentName: '',
    owner: '',
    supportTeam: '',
    plannedStartDate: '',
    plannedEndDate: '',
    actualProgressStatus: '미착수(0%)',
    actualStartDate: '',
    actualEndDate: '',
    isSynthetic: false
  };
}

function createChildDraft(task) {
  const draft = sanitizeDraft({ ...task });
  if (task.depth === 1) {
    draft.activity = '';
    draft.task = '';
  } else if (task.depth === 2) {
    draft.task = '';
  }
  return draft;
}

function sanitizeDraft(draft) {
  const sanitized = {};
  EDITABLE_FIELDS.forEach((field) => {
    // 🛡️ Sentinel: Enforce string coercion before trim() to prevent DoS via type confusion
    sanitized[field] = String(draft?.[field] || '').trim().slice(0, 1000);
  });
  // 🛡️ Sentinel: Strictly validate against allowed options to prevent injection
  if (!sanitized.actualProgressStatus || !ACTUAL_PROGRESS_OPTIONS.includes(sanitized.actualProgressStatus)) {
    sanitized.actualProgressStatus = '미착수(0%)';
  }
  return sanitized;
}

function validateDraft(draft, depth) {
  const errors = [];
  if (!draft) {
    return errors;
  }
  const sanitized = sanitizeDraft(draft);

  EDITABLE_FIELDS.forEach((field) => {
    if (/[<>]/.test(sanitized[field])) {
      const label = CSV_FIELD_LABELS[field] || field;
      errors.push(`${label} 항목에는 HTML 태그 문자를 사용할 수 없습니다.`);
    }
  });

  if (!sanitized.phase && depth === 1) {
    errors.push('최상위 작업은 단계 값을 입력해야 합니다.');
  }
  if (depth === 2 && !sanitized.activity) {
    errors.push('2단계 작업은 Activity 값을 입력해야 합니다.');
  }
  if (depth === 3 && !sanitized.task) {
    errors.push('3단계 작업은 Task 값을 입력해야 합니다.');
  }

  validateDateField('계획시작일', sanitized.plannedStartDate, errors);
  validateDateField('계획종료일', sanitized.plannedEndDate, errors);
  validateDateField('실적시작일', sanitized.actualStartDate, errors);
  validateDateField('실적종료일', sanitized.actualEndDate, errors);

  validateDateRange('계획시작일', sanitized.plannedStartDate, '계획종료일', sanitized.plannedEndDate, errors);
  validateDateRange('실적시작일', sanitized.actualStartDate, '실적종료일', sanitized.actualEndDate, errors);

  return Array.from(new Set(errors));
}

function validateDateField(label, value, errors) {
  if (!value) {
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isValidDateString(value)) {
    errors.push(`${label}은 YYYY-MM-DD 형식의 실제 달력 날짜여야 합니다.`);
  }
}

function validateDateRange(startLabel, startValue, endLabel, endValue, errors) {
  if (startValue && endValue && compareDateStrings(startValue, endValue) > 0) {
    errors.push(`${endLabel}은 ${startLabel}보다 빠를 수 없습니다.`);
  }
}

function computeTaskMetrics() {
  // ⚡ Bolt: Cache durationDays during total calculation to avoid recalculating for every task
  const durationCache = new Map();
  const totalDays = state.tasks.reduce((sum, task) => {
    const duration = calculateDurationDays(task.plannedStartDate, task.plannedEndDate);
    durationCache.set(task.id, duration);
    return sum + duration;
  }, 0);

  const baseDate = state.baseDate;
  const byTask = new Map();
  let totalWeightedPlannedRatio = 0;
  let totalWeightedActualRatio = 0;

  state.tasks.forEach((task) => {
    const durationDays = durationCache.get(task.id);
    const weightRatio = totalDays > 0 ? durationDays / totalDays : 0;
    const plannedProgressRatio = calculatePlannedProgressRatio(baseDate, task.plannedStartDate, task.plannedEndDate, durationDays);
    const actualProgressRatio = (ACTUAL_PROGRESS_MAP[task.actualProgressStatus] || 0) / 100;
    const weightedPlannedRatio = weightRatio * plannedProgressRatio;
    const weightedActualRatio = weightRatio * actualProgressRatio;
    const plannedDateWarning = getDateRangeWarning(task.plannedStartDate, task.plannedEndDate, '계획종료일이 시작일보다 빠릅니다.');
    const actualDateWarning = getDateRangeWarning(task.actualStartDate, task.actualEndDate, '실적종료일이 시작일보다 빠릅니다.');
    const progressState = deriveProgressState(task, baseDate);

    totalWeightedPlannedRatio += weightedPlannedRatio;
    totalWeightedActualRatio += weightedActualRatio;

    byTask.set(task.id, {
      durationDays,
      weightRatio,
      plannedProgressRatio,
      actualProgressRatio,
      weightedPlannedRatio,
      weightedActualRatio,
      progressState,
      plannedDateWarning,
      actualDateWarning
    });
  });

  return {
    totalDays,
    totalWeightedPlannedRatio,
    totalWeightedActualRatio,
    byTask
  };
}

function deriveProgressState(task, baseDate) {
  if (!task.plannedStartDate || !task.plannedEndDate) {
    return { label: '', className: '' };
  }

  if (task.actualStartDate && task.actualEndDate) {
    return { label: '완료', className: 'done' };
  }
  if (compareDateStrings(baseDate, task.plannedEndDate) >= 0 && (!task.actualStartDate || !task.actualEndDate)) {
    return { label: '지연', className: 'delay' };
  }
  if (task.actualStartDate && !task.actualEndDate) {
    return { label: '진행', className: 'active' };
  }
  if (compareDateStrings(baseDate, task.plannedStartDate) < 0) {
    return { label: '진행전', className: 'before' };
  }
  return { label: '진행전', className: 'before' };
}

function calculatePlannedProgressRatio(baseDate, startDate, endDate, durationDays) {
  if (!baseDate || !startDate || !endDate) {
    return 0;
  }
  if (compareDateStrings(baseDate, startDate) <= 0) {
    return 0;
  }
  if (compareDateStrings(baseDate, endDate) >= 0) {
    return 1;
  }
  // Bolt: Reuse passed durationDays if available to avoid redundant Date parsing and calculations.
  const total = durationDays !== undefined ? durationDays : calculateDurationDays(startDate, endDate);
  if (total <= 0) {
    return 1;
  }
  const elapsed = calculateDurationDays(startDate, baseDate);
  return clamp(elapsed / total, 0, 1);
}

function calculateDurationDays(startDate, endDate) {
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return 0;
  }
  const start = dateStringToUtcMs(startDate);
  const end = dateStringToUtcMs(endDate);
  if (end < start) {
    return 0;
  }
  return Math.max(1, Math.round((end - start) / 86400000));
}

function getDateRangeWarning(startDate, endDate, message) {
  if (isValidDateString(startDate) && isValidDateString(endDate) && compareDateStrings(startDate, endDate) > 0) {
    return message;
  }
  return '';
}

const cachedHiddenParentIds = new Set();

function getVisibleTasks() {
  const visible = [];
  cachedHiddenParentIds.clear();

  // ⚡ Bolt Optimization: Single-pass O(N) visible task filtering to avoid redundant O(N * Depth) tree traversals
  state.tasks.forEach((task) => {
    if (cachedHiddenParentIds.has(task.parentId)) {
      cachedHiddenParentIds.add(task.id);
      return;
    }

    visible.push(task);
    if (!task.expanded) {
      cachedHiddenParentIds.add(task.id);
    }
  });

  return visible;
}

function insertTaskAfter(task, afterId) {
  if (!afterId) {
    state.tasks.unshift(task);
    invalidateTaskIndexCache();
    return;
  }
  const index = getTaskIndexById(afterId);
  if (index === -1) {
    state.tasks.push(task);
    invalidateTaskIndexCache();
    return;
  }
  state.tasks.splice(index + 1, 0, task);
  invalidateTaskIndexCache();
}

function deleteTaskAndDescendants(taskId) {
  // ⚡ Bolt: Replace O(N * Depth) cascading loop with O(N) map-based BFS to prevent UI freeze during deletion
  const childrenMap = new Map();
  state.tasks.forEach(task => {
    if (task.parentId) {
      const children = childrenMap.get(task.parentId) || [];
      children.push(task.id);
      childrenMap.set(task.parentId, children);
    }
  });

  const idsToDelete = new Set([taskId]);
  const queue = [taskId];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const currentId = queue[queueIndex++];
    const children = childrenMap.get(currentId);
    if (children) {
      children.forEach(childId => {
        if (!idsToDelete.has(childId)) {
          idsToDelete.add(childId);
          queue.push(childId);
        }
      });
    }
  }
  state.tasks = state.tasks.filter((task) => !idsToDelete.has(task.id));
  invalidateTaskIndexCache();
}

function reorderTaskWithinLevel(draggedId, targetId, placeAfter = true) {
  const draggedRange = getTaskSubtreeRange(draggedId);
  const targetRange = getTaskSubtreeRange(targetId);
  if (!draggedRange || !targetRange) {
    return;
  }
  const draggedBlock = state.tasks.slice(draggedRange.startIndex, draggedRange.endIndex + 1);
  state.tasks.splice(draggedRange.startIndex, draggedBlock.length);
  invalidateTaskIndexCache();

  const refreshedTargetRange = getTaskSubtreeRange(targetId);
  const insertionIndex = refreshedTargetRange
    ? (placeAfter ? refreshedTargetRange.endIndex + 1 : refreshedTargetRange.startIndex)
    : state.tasks.length;
  state.tasks.splice(insertionIndex, 0, ...draggedBlock);
  invalidateTaskIndexCache();
}

function canReorderWithinLevel(draggedTask, targetTask) {
  return draggedTask.depth === targetTask.depth && draggedTask.parentId === targetTask.parentId;
}

function createOwnerColorMap() {
  const ownerColorMap = new Map();
  state.tasks.forEach((task) => {
    if (task.owner && !ownerColorMap.has(task.owner)) {
      ownerColorMap.set(task.owner, OWNER_COLORS[ownerColorMap.size % OWNER_COLORS.length]);
    }
  });
  return ownerColorMap;
}

function getLastRootTaskId() {
  // Walk backward to avoid allocating an intermediate roots array.
  let lastRoot = null;
  for (let i = state.tasks.length - 1; i >= 0; i -= 1) {
    if (!state.tasks[i].parentId) {
      lastRoot = state.tasks[i];
      break;
    }
  }
  return lastRoot ? getLastDescendantId(lastRoot.id) : null;
}

function getLastDescendantId(taskId) {
  const startIndex = getTaskIndexById(taskId);
  if (startIndex === -1) {
    return taskId;
  }
  const baseDepth = state.tasks[startIndex].depth;
  let lastId = taskId;
  for (let index = startIndex + 1; index < state.tasks.length; index += 1) {
    if (state.tasks[index].depth <= baseDepth) {
      break;
    }
    lastId = state.tasks[index].id;
  }
  return lastId;
}

function getTaskSubtreeRange(taskId) {
  const startIndex = getTaskIndexById(taskId);
  if (startIndex === -1) {
    return null;
  }

  const baseDepth = state.tasks[startIndex].depth;
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < state.tasks.length; index += 1) {
    if (state.tasks[index].depth <= baseDepth) {
      break;
    }
    endIndex = index;
  }

  return { startIndex, endIndex };
}

function findTask(taskId) {
  const index = getTaskIndexById(taskId);
  return index !== -1 ? state.tasks[index] : null;
}

function persistState() {
  // ⚡ Bolt: Remove redundant O(N) object cloning before JSON.stringify to prevent massive memory allocations on every keystroke
  const payload = {
    projectName: state.projectName,
    baseDate: state.baseDate,
    tasks: state.tasks
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error('State persistence failed:', error);
    showToast('로컬 스토리지 용량이 초과되어 저장하지 못했습니다.');
  }

  if (state.jsonSyncHandle) {
    writeJsonSyncFile().catch(() => {
      showToast('연결된 wbs.json 파일 저장에 실패했습니다.');
    });
  }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseSafeJson(raw) : null;
  } catch {
    return null;
  }
}

function hydrateState(savedState) {
  state.projectName = String(savedState.projectName || DEFAULT_PROJECT_NAME).trim().slice(0, MAX_PROJECT_NAME_LENGTH) || DEFAULT_PROJECT_NAME;
  state.baseDate = String(savedState.baseDate || '').trim().slice(0, MAX_BASE_DATE_LENGTH) || formatLocalDateInput(new Date());
  state.tasks = Array.isArray(savedState.tasks)
    ? savedState.tasks.filter(isTaskRecord).map(normalizeStoredTask)
    : [];
  invalidateTaskIndexCache();
}

function normalizeStoredTask(task) {
  const safeTask = isTaskRecord(task) ? task : {};
  const normalizedTask = {
    ...safeTask,
    plannedEndDate: getPlannedEndDateValue(safeTask),
    expanded: safeTask.expanded !== false
  };
  delete normalizedTask[LEGACY_PLANNED_END_FIELD];
  return normalizedTask;
}

async function loadSeedTasks() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('./wbs.json', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw new Error('seed-load-failed');
    }
    return parseSafeJson(await response.text());
  } catch {
    return [];
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function parseSafeJson(text) {
  return JSON.parse(text, (key, value) => (UNSAFE_JSON_KEYS.has(key) ? undefined : value));
}

function getPlannedEndDateValue(task) {
  if (!isTaskRecord(task)) {
    return '';
  }
  return task.plannedEndDate || task[LEGACY_PLANNED_END_FIELD] || '';
}

function isTaskRecord(task) {
  return task !== null && typeof task === 'object' && !Array.isArray(task);
}

function normalizeImportedTasks(sourceTasks) {
  if (!Array.isArray(sourceTasks)) {
    return [];
  }
  sourceTasks.forEach((task, index) => validateImportedTask(task, index));
  const hasExplicitDepth = sourceTasks.some((task) => task.__depth || task.__id || task.__parentId);
  if (!hasExplicitDepth) {
    return buildHierarchicalTasksFromFlatSource(sourceTasks);
  }
  return sourceTasks.map((task, index) => ({
    ...createNormalizedExternalRecord(task),
    id: task.__id || createId(index + 1),
    parentId: task.__parentId || null,
    depth: Number(task.__depth) || inferDepth(task),
    expanded: true,
    pendingDelete: false,
    isSynthetic: Boolean(task.isSynthetic)
  }));
}

function validateImportedTask(task, index) {
  const rowLabel = `${index + 2}행`;
  const plannedStartDate = task.plannedStartDate || '';
  const plannedEndDate = getPlannedEndDateValue(task);
  const actualStartDate = task.actualStartDate || '';
  const actualEndDate = task.actualEndDate || '';

  [
    ['계획시작일', plannedStartDate],
    ['계획종료일', plannedEndDate],
    ['실적시작일', actualStartDate],
    ['실적종료일', actualEndDate]
  ].forEach(([label, value]) => {
    if (value && !isValidDateString(value)) {
      throw new Error(`${rowLabel}: ${label}은 YYYY-MM-DD 형식의 실제 달력 날짜여야 합니다.`);
    }
  });

  const dateRangeErrors = [];
  validateDateRange('계획시작일', plannedStartDate, '계획종료일', plannedEndDate, dateRangeErrors);
  validateDateRange('실적시작일', actualStartDate, '실적종료일', actualEndDate, dateRangeErrors);
  if (dateRangeErrors.length > 0) {
    throw new Error(`${rowLabel}: ${dateRangeErrors[0]}`);
  }
}

const createNormalizedExternalRecord = (task, defaults = {}) => ({
  ...createEmptyTaskDraft(),
  ...defaults,
  phase: task.phase || defaults.phase || '',
  activity: task.activity || defaults.activity || '',
  task: task.task || defaults.task || '',
  categoryLarge: task.categoryLarge || '',
  categoryMedium: task.categoryMedium || '',
  documentName: task.documentName || '',
  owner: task.owner || '',
  supportTeam: task.supportTeam || '',
  plannedStartDate: task.plannedStartDate || '',
  plannedEndDate: getPlannedEndDateValue(task),
  actualProgressStatus: ACTUAL_PROGRESS_MAP[task.actualProgressStatus] !== undefined ? task.actualProgressStatus : '미착수(0%)',
  actualStartDate: task.actualStartDate || '',
  actualEndDate: task.actualEndDate || ''
});

function getPhaseKey(task, index) {
  return task.phase || `__phase-${index}`;
}

function getActivityKey(task, index) {
  return `${getPhaseKey(task, index)}::${task.activity || `__activity-${index}`}`;
}

function ensureSyntheticNode(map, key, idPrefix, index, pushCallback) {
  if (!map.has(key)) {
    const id = createId(`${idPrefix}-${index}`);
    pushCallback(id);
    map.set(key, id);
  }
  return map.get(key);
}

function buildHierarchicalTasksFromFlatSource(sourceTasks) {
  const normalized = [];
  const phaseMap = new Map();
  const activityMap = new Map();

  const ensureSyntheticPhase = (task, index) => {
    const phaseKey = getPhaseKey(task, index);
    return ensureSyntheticNode(phaseMap, phaseKey, 'phase', index, (phaseId) => {
      normalized.push({
        ...createNormalizedExternalRecord({ phase: task.phase }),
        id: phaseId,
        parentId: null,
        depth: 1,
        expanded: true,
        pendingDelete: false,
        isSynthetic: true
      });
    });
  };

  const ensureSyntheticActivity = (task, index, parentPhaseId) => {
    const key = getActivityKey(task, index);
    return ensureSyntheticNode(activityMap, key, 'activity', index, (activityId) => {
      normalized.push({
        ...createNormalizedExternalRecord({ phase: task.phase, activity: task.activity }),
        id: activityId,
        parentId: parentPhaseId,
        depth: 2,
        expanded: true,
        pendingDelete: false,
        isSynthetic: true
      });
    });
  };

  sourceTasks.forEach((task, index) => {
    const hasPhase = Boolean(task.phase);
    const hasActivity = Boolean(task.activity);
    const hasTask = Boolean(task.task);

    if (hasPhase && !hasActivity && !hasTask) {
      const phaseId = createId(`phase-${index}`);
      normalized.push({
        ...createNormalizedExternalRecord(task),
        id: phaseId,
        parentId: null,
        depth: 1,
        expanded: true,
        pendingDelete: false,
        isSynthetic: false
      });
      phaseMap.set(getPhaseKey(task, index), phaseId);
      return;
    }

    const parentPhaseId = ensureSyntheticPhase(task, index);

    if (hasActivity && !hasTask) {
      const activityId = createId(`activity-${index}`);
      normalized.push({
        ...createNormalizedExternalRecord(task),
        id: activityId,
        parentId: parentPhaseId,
        depth: 2,
        expanded: true,
        pendingDelete: false,
        isSynthetic: false
      });
      activityMap.set(getActivityKey(task, index), activityId);
      return;
    }

    const parentActivityId = hasTask ? ensureSyntheticActivity(task, index, parentPhaseId) : parentPhaseId;
    normalized.push({
      ...createNormalizedExternalRecord(task),
      id: createId(`leaf-${index}`),
      parentId: hasTask ? parentActivityId : parentPhaseId,
      depth: hasTask ? 3 : hasActivity ? 2 : 1,
      expanded: true,
      pendingDelete: false,
      isSynthetic: false
    });
  });

  return normalized;
}

function inferDepth(task) {
  if (task.task) {
    return 3;
  }
  if (task.activity) {
    return 2;
  }
  return 1;
}

function exportCsv() {
  const metrics = computeTaskMetrics();
  const rows = state.tasks.map((task) => {
    const taskMetrics = metrics.byTask.get(task.id);
    return [
      task.phase,
      task.activity,
      task.task,
      task.categoryLarge,
      task.categoryMedium,
      task.documentName,
      task.owner,
      task.supportTeam,
      taskMetrics.progressState.label,
      task.plannedStartDate,
      task.plannedEndDate,
      formatNumber(taskMetrics.durationDays),
      formatPercent(taskMetrics.plannedProgressRatio * 100, 2),
      formatDecimal(taskMetrics.weightRatio, 3),
      formatPercent(taskMetrics.weightedPlannedRatio * 100, 2),
      task.actualProgressStatus,
      formatPercent(taskMetrics.actualProgressRatio * 100, 2),
      task.actualStartDate,
      task.actualEndDate,
      formatPercent(taskMetrics.weightedActualRatio * 100, 2),
      task.id,
      task.parentId || '',
      task.depth
    ];
  });

  const csvText = [CSV_HEADERS, ...rows]
    .map((row) => row.map((cell) => csvEscape(cell)).join(','))
    .join('\r\n');
  downloadFile(csvText, `wbs_export_${formatCompactDate(new Date())}.csv`, 'text/csv;charset=utf-8');
}

async function handleCsvImport(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showToast('파일 크기는 5MB를 초과할 수 없습니다.');
    event.target.value = '';
    return;
  }

  try {
    const text = await file.text();
    const imported = parseCsv(text);
    state.tasks = validateImportedTasks(normalizeImportedTasks(imported));
    invalidateTaskIndexCache();
    closeEditor();
    persistState();
    renderAll();
    showToast('CSV를 가져왔습니다. 기존 데이터는 새 CSV로 대체되었습니다.');
  } catch (error) {
    showToast(`CSV 가져오기에 실패했습니다: ${error.message}`);
  } finally {
    event.target.value = '';
  }
}

window.__scopeweaveTestApi = Object.assign(window.__scopeweaveTestApi || {}, {
  validateImportedTasks
});

function validateImportedTasks(tasks) {
  const seenIds = new Set();
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      throw new Error(`중복된 ID가 발견되었습니다: ${task.id}`);
    }
    seenIds.add(task.id);
  }
  for (const task of tasks) {
    if (task.parentId && !seenIds.has(task.parentId)) {
      throw new Error(`존재하지 않는 부모 ID를 참조합니다: ${task.parentId}`);
    }
  }
  // Detect cycles
  // ⚡ Bolt: Use O(1) Map lookup instead of O(N) tasks.find to prevent O(N^2) bottleneck during cycle detection
  const taskById = new Map(tasks.map(t => [t.id, t]));
  for (const task of tasks) {
    let current = task.parentId;
    const visited = new Set([task.id]);
    while (current) {
      if (visited.has(current)) {
        throw new Error(`순환 참조가 발견되었습니다: ${task.id}`);
      }
      visited.add(current);
      const parentTask = taskById.get(current);
      current = parentTask ? parentTask.parentId : null;
    }
  }
  return tasks;
}

function validateCsvCell(value, fieldName) {
  if (!value) return value;
  const normalized = String(value);
  const label = CSV_FIELD_LABELS[fieldName] || fieldName;
  if (normalized.length > 1000) {
    throw new Error(`${label} 컬럼은 1000자 이하로 입력해야 합니다.`);
  }
  if (/[<>]/.test(normalized)) {
    throw new Error(`${label} 컬럼에는 HTML 태그 문자를 사용할 수 없습니다.`);
  }
  return sanitizeCsvFormulaValue(normalized);
}

function validateCsvInternalValue(value, fieldName) {
  return validateCsvCell(value, fieldName);
}

function validateCsvId(value) { return validateCsvInternalValue(value, '__id'); }
function validateCsvParentId(value) { return validateCsvInternalValue(value, '__parentId'); }
function validateCsvDepth(value) {
  const normalized = validateCsvInternalValue(value, '__depth');
  if (normalized && !/^[1-3]$/.test(normalized)) {
    throw new Error('__depth 컬럼은 1, 2, 3 중 하나여야 합니다.');
  }
  return normalized;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  if (current || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  if (rows.length < 2) {
    throw new Error('CSV 데이터가 비어 있습니다.');
  }

  const header = rows[0];
  const headerMap = new Map(header.map((name, index) => [name.replace(/^\ufeff/, ''), index]));

  const requiredHeaders = ['단계', 'Activity', 'Task', '대분류', '중분류', '산출물', '담당자', '지원팀', '실적진척상태', '계획시작일', '계획종료일', '실적시작일', '실적종료일'];
  requiredHeaders.forEach((name) => {
    if (!headerMap.has(name)) {
      throw new Error(`필수 컬럼이 없습니다: ${name}`);
    }
  });

  return rows.slice(1).filter((cells) => cells.some((cell) => String(cell ?? '').trim() !== '')).map((cells) => ({
    phase: validateCsvCell(readCsvCell(cells, headerMap, '단계'), 'phase'),
    activity: validateCsvCell(readCsvCell(cells, headerMap, 'Activity'), 'activity'),
    task: validateCsvCell(readCsvCell(cells, headerMap, 'Task'), 'task'),
    categoryLarge: validateCsvCell(readCsvCell(cells, headerMap, '대분류'), 'categoryLarge'),
    categoryMedium: validateCsvCell(readCsvCell(cells, headerMap, '중분류'), 'categoryMedium'),
    documentName: validateCsvCell(readCsvCell(cells, headerMap, '산출물'), 'documentName'),
    owner: validateCsvCell(readCsvCell(cells, headerMap, '담당자'), 'owner'),
    supportTeam: validateCsvCell(readCsvCell(cells, headerMap, '지원팀'), 'supportTeam'),
    plannedStartDate: validateCsvCell(readCsvCell(cells, headerMap, '계획시작일'), 'plannedStartDate'),
    plannedEndDate: validateCsvCell(readCsvCell(cells, headerMap, '계획종료일'), 'plannedEndDate'),
    actualProgressStatus: validateCsvCell(readCsvCell(cells, headerMap, '실적진척상태') || '미착수(0%)', 'actualProgressStatus'),
    actualStartDate: validateCsvCell(readCsvCell(cells, headerMap, '실적시작일'), 'actualStartDate'),
    actualEndDate: validateCsvCell(readCsvCell(cells, headerMap, '실적종료일'), 'actualEndDate'),
    __id: validateCsvId(readCsvCell(cells, headerMap, '__id')),
    __parentId: validateCsvParentId(readCsvCell(cells, headerMap, '__parentId')),
    __depth: validateCsvDepth(readCsvCell(cells, headerMap, '__depth'))
  }));
}

function readCsvCell(cells, headerMap, name) {
  const index = headerMap.get(name);
  return index === undefined ? '' : String(cells[index] ?? '').trim();
}

async function connectJsonSync() {
  if (!window.showSaveFilePicker) {
    showToast('이 브라우저는 wbs.json 직접 저장 연결을 지원하지 않습니다.');
    return;
  }

  try {
    state.jsonSyncHandle = await window.showSaveFilePicker({
      suggestedName: 'wbs.json',
      types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }]
    });
    await writeJsonSyncFile();
    renderAll();
    showToast('wbs.json 자동저장 연결이 완료되었습니다.');
  } catch (error) {
    if (error.name !== 'AbortError') {
      showToast('wbs.json 연결에 실패했습니다.');
    }
  }
}

async function writeJsonSyncFile() {
  if (!state.jsonSyncHandle) {
    return;
  }
  const writable = await state.jsonSyncHandle.createWritable();
  await writable.write(JSON.stringify(exportJsonArray(), null, 2));
  await writable.close();
}

function exportJsonArray() {
  return state.tasks.filter((task) => !task.isSynthetic).map((task) => ({
    phase: task.phase,
    activity: task.activity,
    task: task.task,
    categoryLarge: task.categoryLarge,
    categoryMedium: task.categoryMedium,
    documentName: task.documentName,
    owner: task.owner,
    supportTeam: task.supportTeam,
    plannedStartDate: task.plannedStartDate,
    plannedEndDate: task.plannedEndDate,
    [LEGACY_PLANNED_END_FIELD]: task.plannedEndDate,
    actualProgressStatus: task.actualProgressStatus,
    actualStartDate: task.actualStartDate,
    actualEndDate: task.actualEndDate
  }));
}

function openGanttModal() {
  state.previousFocus = document.activeElement;
  elements.ganttModal.classList.remove('hidden');
  renderGantt();
  // Focus the modal to handle Escape key properly
  elements.ganttModal.focus();
}

function closeGanttModal() {
  elements.ganttModal.classList.add('hidden');
  if (state.previousFocus) {
    state.previousFocus.focus();
    state.previousFocus = null;
  }
}

function getGanttModalFocusableElements() {
  return Array.from(elements.ganttModal.querySelectorAll([
    'a[href]',
    'button:not(:disabled):not([aria-disabled="true"])',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    '[tabindex]:not([tabindex="-1"])'
  ].join(','))).filter((element) => (
    !element.closest('.hidden') && element.offsetParent !== null
  ));
}

function trapGanttModalFocus(event) {
  const focusableElements = getGanttModalFocusableElements();
  if (focusableElements.length === 0) {
    elements.ganttModal.focus();
    event.preventDefault();
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement;

  if (event.shiftKey && (activeElement === firstElement || activeElement === elements.ganttModal)) {
    lastElement.focus();
    event.preventDefault();
  } else if (!event.shiftKey && activeElement === lastElement) {
    firstElement.focus();
    event.preventDefault();
  }
}

function renderGantt() {
  const plannedTasks = state.tasks.filter((task) => isValidDateString(task.plannedStartDate) && isValidDateString(task.plannedEndDate));
  if (plannedTasks.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'gantt-empty table-empty';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '📊';

    const title = document.createElement('h3');
    title.className = 'empty-title';
    title.textContent = '표시할 간트 차트가 없습니다';

    const description = document.createElement('p');
    description.className = 'empty-desc';

    const strongStart = document.createElement('strong');
    strongStart.textContent = '계획시작일';

    const strongEnd = document.createElement('strong');
    strongEnd.textContent = '계획종료일';

    description.append(
      '작업 목록에서 ',
      strongStart,
      '과 ',
      strongEnd,
      '을 입력하면 차트가 나타납니다.'
    );

    const actions = document.createElement('div');
    actions.className = 'empty-actions editor-actions';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'primary-button';
    backBtn.textContent = '작업 목록으로 돌아가기';
    backBtn.addEventListener('click', closeGanttModal);

    actions.appendChild(backBtn);

    emptyDiv.append(icon, title, description, actions);
    elements.ganttContent.replaceChildren(emptyDiv);
    return;
  }

  // ⚡ Bolt: Use direct string comparison for minDate/maxDate calculation since plannedTasks already filter for valid dates.
  const minDate = plannedTasks.reduce((min, task) => (task.plannedStartDate < min ? task.plannedStartDate : min), plannedTasks[0].plannedStartDate);
  const maxDate = plannedTasks.reduce((max, task) => (task.plannedEndDate > max ? task.plannedEndDate : max), plannedTasks[0].plannedEndDate);
  const weekdays = buildWeekdayTimeline(minDate, maxDate);
  const weeks = groupTimelineByWeek(weekdays);

  const totalWidth = weekdays.length * 36;

  const shell = document.createElement('div');
  shell.className = 'gantt-shell';

  const meta = document.createElement('div');
  meta.className = 'gantt-meta';
  meta.appendChild(createGanttMetaTable());

  const chart = document.createElement('div');
  chart.className = 'gantt-chart';
  chart.appendChild(createGanttChartTable(weeks, weekdays, totalWidth));

  shell.append(meta, chart);
  elements.ganttContent.replaceChildren(shell);
}

function createGanttMetaTable() {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  [
    '단계',
    'Activity',
    'Task',
    '대분류',
    '중분류',
    '산출물',
    '담당자',
    '지원팀',
    '계획시작일',
    '계획종료일',
    '실적시작일',
    '실적종료일'
  ].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  const tbody = document.createElement('tbody');
  state.tasks.forEach((task) => {
    const row = document.createElement('tr');
    row.append(
      createTableCell('', createTreeCellContent(task.phase || task.activity || task.task || '-', task.depth)),
      createTableCell('', createTextCellContent(task.activity)),
      createTableCell('', createTextCellContent(task.task)),
      createTableCell('', createTextCellContent(task.categoryLarge)),
      createTableCell('', createTextCellContent(task.categoryMedium)),
      createTableCell('', createTextCellContent(task.documentName)),
      createTableCell('', createTextCellContent(task.owner)),
      createTableCell('', createTextCellContent(task.supportTeam)),
      createTableCell('', createTextCellContent(task.plannedStartDate)),
      createTableCell('', createTextCellContent(task.plannedEndDate)),
      createTableCell('', createTextCellContent(task.actualStartDate)),
      createTableCell('', createTextCellContent(task.actualEndDate))
    );
    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  return table;
}

function createGanttChartTable(weeks, weekdays, totalWidth) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const weekRow = document.createElement('tr');
  weeks.forEach((week) => {
    const th = document.createElement('th');
    th.className = 'gantt-week-header';
    th.colSpan = week.days.length;
    th.textContent = week.label;
    weekRow.appendChild(th);
  });

  const dayRow = document.createElement('tr');
  weekdays.forEach((day) => {
    const th = document.createElement('th');
    th.className = 'gantt-day-cell';
    th.textContent = day.dayLabel;
    dayRow.appendChild(th);
  });
  thead.append(weekRow, dayRow);

  const tbody = document.createElement('tbody');
  state.tasks.forEach((task) => {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = weekdays.length;

    const track = document.createElement('div');
    track.className = 'gantt-day-track';
    track.style.width = `${totalWidth}px`;

    const planBar = createGanttBarElement(task.plannedStartDate, task.plannedEndDate, weekdays, 'plan', task);
    const actualBar = createGanttBarElement(task.actualStartDate, task.actualEndDate, weekdays, 'actual', task);
    if (planBar) {
      track.appendChild(planBar);
    }
    if (actualBar) {
      track.appendChild(actualBar);
    }

    cell.appendChild(track);
    row.appendChild(cell);
    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  return table;
}

function buildWeekdayTimeline(minDate, maxDate) {
  const days = [];
  let cursor = getMonday(minDate);
  const endBoundary = getFriday(maxDate);
  // ⚡ Bolt: Use direct string comparison for cursor loop since both are generated valid dates.
  while (cursor <= endBoundary) {
    if (!isWeekend(cursor)) {
      days.push({
        date: cursor,
        dayLabel: cursor.slice(8, 10)
      });
    }
    cursor = addDays(cursor, 1);
  }
  return days;
}

function groupTimelineByWeek(days) {
  // ⚡ Bolt: Use an O(1) Map instead of O(N) Array.find to avoid O(N^2) bottleneck when grouping timeline days
  const groups = [];
  const groupMap = new Map();
  days.forEach((day) => {
    const monday = getMonday(day.date);
    const existing = groupMap.get(monday);
    if (existing) {
      existing.days.push(day);
    } else {
      const newGroup = {
        monday,
        label: `${monday.slice(5, 7)}월 ${monday.slice(8, 10)}일 주간`,
        days: [day]
      };
      groups.push(newGroup);
      groupMap.set(monday, newGroup);
    }
  });
  return groups;
}

function findFirstWeekdayIndexOnOrAfter(weekdays, targetDate) {
  let result = -1;
  let low = 0;
  let high = weekdays.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (weekdays[mid].date >= targetDate) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return result;
}

function findLastWeekdayIndexOnOrBefore(weekdays, targetDate) {
  let result = -1;
  let low = 0;
  let high = weekdays.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (weekdays[mid].date <= targetDate) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function createGanttBarElement(startDate, endDate, weekdays, type, task) {
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return null;
  }
  const startIndex = findFirstWeekdayIndexOnOrAfter(weekdays, startDate);
  const normalizedEndIndex = findLastWeekdayIndexOnOrBefore(weekdays, endDate);

  if (startIndex === -1 || normalizedEndIndex === -1) {
    return null;
  }
  if (normalizedEndIndex < startIndex) {
    return null;
  }
  const bar = document.createElement('div');
  bar.className = `gantt-bar ${type}`;
  bar.style.left = `${startIndex * 36}px`;
  bar.style.width = `${(normalizedEndIndex - startIndex + 1) * 36}px`;

  const taskName = task.task || task.activity || task.phase || '작업';
  const typeLabel = type === 'plan' ? '계획' : '실적';
  const visibleStartDate = weekdays[startIndex].date;
  const visibleEndDate = weekdays[normalizedEndIndex].date;
  const tooltipText = `${taskName} ${typeLabel} (${visibleStartDate} ~ ${visibleEndDate})`;

  bar.title = tooltipText;
  bar.setAttribute('aria-label', tooltipText);
  bar.setAttribute('role', 'img');
  bar.tabIndex = 0;

  return bar;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2200);
}

function clearDragState() {
  state.dragTaskId = null;
  state.dragTaskCache = null;
  if (state.dragElement) {
    state.dragElement.classList.remove('dragging');
    state.dragElement = null;
  }
  clearDropTargets();
}

function clearDropTargets() {
  if (state.dropTargetElement) {
    state.dropTargetElement.classList.remove('drop-target');
    delete state.dropTargetElement.dataset.dropPosition;
    state.dropTargetElement = null;
  }
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  // Keep generated download links isolated from any browsing context changes.
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  Element.prototype.remove.call(link);
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const normalized = sanitizeCsvFormulaValue(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function sanitizeCsvFormulaValue(value) {
  const normalized = String(value ?? '');
  return CSV_FORMULA_PREFIX_PATTERN.test(normalized) ? `'${normalized}` : normalized;
}

function createId(seed = Date.now()) {
  // Security enhancement: Prefer crypto.randomUUID for stronger randomness
  if (typeof crypto !== 'undefined') {
    if (crypto.randomUUID) {
      return `task-${crypto.randomUUID()}`;
    }
    // Fallback: use crypto.getRandomValues if randomUUID is unavailable
    if (crypto.getRandomValues) {
      const arr = new Uint32Array(2);
      crypto.getRandomValues(arr);
      return `task-${arr[0].toString(16)}-${arr[1].toString(16)}`;
    }
  }
  throw new Error('Secure random number generation is not supported in this environment');
}

// ⚡ Bolt: Memoize date parsing and validation to reduce GC pressure and expensive Date allocations in tight render loops

function isValidDateString(value) {
  if (!isValidDateString.cache) isValidDateString.cache = new Map();
  const validDateCache = isValidDateString.cache;

  if (validDateCache.has(value)) {
    return validDateCache.get(value);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const isValid = formatDateInput(new Date(dateStringToUtcMs(value))) === value;
  // Bolt: Increase cache limits to prevent cache thrashing in large loops.
  if (validDateCache.size < 10000) {
    validDateCache.set(value, isValid);
  }
  return isValid;
}

function dateStringToUtcMs(value) {
  if (!dateStringToUtcMs.cache) dateStringToUtcMs.cache = new Map();
  const dateToUtcMsCache = dateStringToUtcMs.cache;

  if (dateToUtcMsCache.has(value)) {
    return dateToUtcMsCache.get(value);
  }
  // Bolt: Avoid split().map() array allocations in tight rendering loops.
  const year = Number(value.substring(0, 4));
  const month = Number(value.substring(5, 7));
  const day = Number(value.substring(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  // Bolt: Increase cache limits to prevent cache thrashing in large loops.
  if (dateToUtcMsCache.size < 10000) {
    dateToUtcMsCache.set(value, ms);
  }
  return ms;
}

function compareDateStrings(left, right) {
  if (!isValidDateString(left) || !isValidDateString(right)) {
    return 0;
  }
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function addDays(value, amount) {
  const date = new Date(dateStringToUtcMs(value));
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDateInput(date);
}

function getMonday(value) {
  const date = new Date(dateStringToUtcMs(value));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return formatDateInput(date);
}

function getFriday(value) {
  const date = new Date(dateStringToUtcMs(value));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + (5 - day));
  return formatDateInput(date);
}

function isWeekend(value) {
  const day = new Date(dateStringToUtcMs(value)).getUTCDay();
  return day === 0 || day === 6;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDateInput(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatCompactDate(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function formatPercent(value, digits) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function formatDecimal(value, digits) {
  return Number(value || 0).toFixed(digits);
}

function formatNumber(value) {
  if (!formatNumber.formatter) {
    formatNumber.formatter = new Intl.NumberFormat('ko-KR');
  }
  return formatNumber.formatter.format(Number(value || 0));
}

const HTML_ESCAPE_ENTITIES = Object.assign(Object.create(null), {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE_ENTITIES[character]);
}

function toKebab(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function debounce(callback, wait) {
  let timeoutId = null;
  const debounced = (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      callback(...args);
    }, wait);
  };
  debounced.flush = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
    callback();
  };
  return debounced;
}

// Export for testing
if (typeof window !== 'undefined') {
  window.validateDraft = validateDraft;
}

bootstrap();
