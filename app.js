const STORAGE_KEY = 'scopeweave:planner-state:v1';
const DEFAULT_PROJECT_NAME = 'ScopeWeave Planner';
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
  'plannedEndDdate',
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

const state = {
  projectName: DEFAULT_PROJECT_NAME,
  baseDate: formatLocalDateInput(new Date()),
  tasks: [],
  editor: {
    mode: null,
    targetId: null,
    parentId: null,
    depth: 1,
    insertAfterId: null,
    draft: null,
    errors: []
  },
  jsonSyncHandle: null,
  dragTaskId: null,
  toastTimer: null
};

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

bootstrap();

async function bootstrap() {
  bindEvents();

  const savedState = loadLocalState();
  if (savedState) {
    hydrateState(savedState);
  } else {
    const seedData = await loadSeedTasks();
    state.tasks = normalizeImportedTasks(seedData);
  }

  renderAll();
}

function bindEvents() {
  elements.projectNameInput.addEventListener('input', (event) => {
    state.projectName = event.target.value.trim() || DEFAULT_PROJECT_NAME;
    persistState();
    renderAll();
  });

  elements.baseDateInput.addEventListener('input', (event) => {
    state.baseDate = event.target.value || formatLocalDateInput(new Date());
    persistState();
    renderAll();
  });

  elements.addRootButton.addEventListener('click', () => openEditor({ mode: 'create', parentId: null, depth: 1, insertAfterId: getLastRootTaskId() }));
  elements.exportCsvButton.addEventListener('click', exportCsv);
  elements.importCsvButton.addEventListener('click', () => elements.csvFileInput.click());
  elements.csvFileInput.addEventListener('change', handleCsvImport);
  elements.openGanttButton.addEventListener('click', openGanttModal);
  elements.closeGanttButton.addEventListener('click', closeGanttModal);
  elements.ganttModal.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') {
      closeGanttModal();
    }
  });

  elements.connectJsonSyncButton.addEventListener('click', async () => {
    await connectJsonSync();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!elements.ganttModal.classList.contains('hidden')) {
        closeGanttModal();
      } else if (state.editor.mode) {
        closeEditor();
      }
    }
  });

  elements.tableBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row) {
      return;
    }

    const taskId = row.dataset.taskId;
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      handleRowAction(actionButton.dataset.action, taskId);
      return;
    }

    if (!event.target.closest('input, select, button, label')) {
      openEditor({ mode: 'edit', targetId: taskId });
    }
  });

  elements.tableBody.addEventListener('input', (event) => {
    const field = event.target.dataset.editorField;
    if (!field || !state.editor.draft) {
      return;
    }
    state.editor.draft[field] = event.target.value;
    renderEditorValidation();
  });

  elements.tableBody.addEventListener('change', (event) => {
    if (event.target.dataset.inlineProgress) {
      handleInlineProgressChange(event);
      return;
    }
    const field = event.target.dataset.editorField;
    if (!field || !state.editor.draft) {
      return;
    }
    state.editor.draft[field] = event.target.value;
    renderEditorValidation();
  });

  elements.tableBody.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-editor-form="true"]');
    if (!form) {
      return;
    }
    event.preventDefault();
    saveEditor();
  });

  elements.tableBody.addEventListener('dragstart', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row) {
      return;
    }

    state.dragTaskId = row.dataset.taskId;
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

    const draggedTask = findTask(state.dragTaskId);
    const targetTask = findTask(row.dataset.taskId);
    if (!draggedTask || !targetTask || !canReorderWithinLevel(draggedTask, targetTask)) {
      return;
    }

    event.preventDefault();
    clearDropTargets();
    row.classList.add('drop-target');
    const rect = row.getBoundingClientRect();
    row.dataset.dropPosition = event.clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
  });

  elements.tableBody.addEventListener('dragleave', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (row) {
      row.classList.remove('drop-target');
      delete row.dataset.dropPosition;
    }
  });

  elements.tableBody.addEventListener('drop', (event) => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row || !state.dragTaskId) {
      return;
    }

    event.preventDefault();
    const targetTask = findTask(row.dataset.taskId);
    const draggedTask = findTask(state.dragTaskId);
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

function renderAll() {
  const metrics = computeTaskMetrics();

  elements.projectNameInput.value = state.projectName;
  elements.baseDateInput.value = state.baseDate;
  elements.totalDays.textContent = `${formatNumber(metrics.totalDays)}일`;
  elements.plannedProgress.textContent = formatPercent(metrics.totalWeightedPlannedRatio * 100, 2);
  elements.actualProgress.textContent = formatPercent(metrics.totalWeightedActualRatio * 100, 2);
  elements.syncStatus.textContent = state.jsonSyncHandle ? '연결된 wbs.json 파일에 자동저장 중' : '브라우저 로컬 자동저장 사용 중';

  const ownerColorMap = createOwnerColorMap();
  const visibleTasks = getVisibleTasks();
  const rows = [];

  // ⚡ Bolt: Cache parent IDs to convert O(N^2) render loop to O(N)
  const hasChildrenSet = new Set();
  state.tasks.forEach(task => {
    if (task.parentId) hasChildrenSet.add(task.parentId);
  });

  visibleTasks.forEach((task, index) => {
    const taskMetrics = metrics.byTask.get(task.id);
    const hasChildren = hasChildrenSet.has(task.id);
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
    rows.push(`
      <tr>
        <td colspan="21">
          <div class="gantt-empty">
            <div class="empty-icon" aria-hidden="true">📋</div>
            <h3 class="empty-title">등록된 작업이 없습니다</h3>
            <p class="empty-desc">하단의 '최상위 작업 추가' 버튼을 눌러 프로젝트를 시작하거나,<br>'CSV 가져오기'를 통해 기존 데이터를 불러오세요.</p>
          </div>
        </td>
      </tr>
    `);
  }

  elements.tableBody.innerHTML = rows.join('');
  renderEditorValidation();
}

function renderTaskRow(task, taskMetrics, ownerColorMap, index, hasChildren) {
  const toggleButton = hasChildren
    ? `<button type="button" class="toggle-button" data-action="toggle" aria-label="${task.expanded ? '접기' : '펼치기'}" title="${task.expanded ? '접기' : '펼치기'}">${task.expanded ? '▼' : '▶'}</button>`
    : '<span class="toggle-placeholder"></span>';
  const isLeaf = task.depth >= 3;

  return `
    <tr class="task-row depth-${task.depth} ${index % 2 === 1 ? 'striped-even' : ''}" data-task-id="${escapeHtml(task.id)}" draggable="true">
      <td>
        <div class="action-stack">
          ${toggleButton}
          <button type="button" class="icon-button" data-action="add-child" aria-label="하위 추가" title="${isLeaf ? '최대 3단계까지만 추가할 수 있습니다.' : '하위 추가'}" ${isLeaf ? 'disabled' : ''}>＋</button>
          <button type="button" class="icon-button" data-action="edit" aria-label="편집" title="편집">✎</button>
          <button type="button" class="icon-button" data-action="delete" aria-label="삭제" title="삭제">🗑</button>
        </div>
      </td>
      <td>${renderTreeCell(task.phase, task.depth)}</td>
      <td>${renderTextCell(task.activity)}</td>
      <td>${renderTextCell(task.task)}</td>
      <td class="priority-mobile">${renderTextCell(task.categoryLarge)}</td>
      <td class="priority-mobile">${renderTextCell(task.categoryMedium)}</td>
      <td class="priority-desktop">${renderTextCell(task.documentName)}</td>
      <td class="priority-mobile">${renderOwnerCell(task.owner, ownerColorMap)}</td>
      <td class="priority-desktop">${renderTextCell(task.supportTeam)}</td>
      <td class="priority-mobile">${renderStatusCell(taskMetrics.progressState)}</td>
      <td class="priority-mobile">${renderTextCell(task.plannedStartDate)}</td>
      <td class="priority-mobile">${renderTextCell(task.plannedEndDdate)}</td>
      <td class="priority-desktop"><span class="metric-text" data-testid="task-duration-days">${formatNumber(taskMetrics.durationDays)}</span></td>
      <td class="priority-desktop"><span class="metric-text">${formatPercent(taskMetrics.plannedProgressRatio * 100, 2)}</span></td>
      <td class="priority-desktop"><span class="metric-text" data-testid="task-weight-ratio">${formatDecimal(taskMetrics.weightRatio, 3)}</span></td>
      <td class="priority-desktop"><span class="metric-text">${formatPercent(taskMetrics.weightedPlannedRatio * 100, 2)}</span></td>
      <td class="priority-mobile">${renderActualProgressCell(task, taskMetrics)}</td>
      <td class="priority-desktop"><span class="metric-text">${formatPercent(taskMetrics.actualProgressRatio * 100, 2)}</span></td>
      <td class="priority-mobile">${renderTextCell(task.actualStartDate, taskMetrics.actualDateWarning)}</td>
      <td class="priority-mobile">${renderTextCell(task.actualEndDate, taskMetrics.actualDateWarning)}</td>
      <td class="priority-desktop"><span class="metric-text">${formatPercent(taskMetrics.weightedActualRatio * 100, 2)}</span></td>
    </tr>
  `;
}

function renderEditorRow(anchorId) {
  const draft = state.editor.draft || createEmptyTaskDraft();
  const depth = state.editor.depth;
  return `
    <tr class="editor-row" data-editor-anchor="${escapeHtml(anchorId)}">
      <td colspan="21">
        <div class="editor-panel">
          <form data-editor-form="true">
            <div class="editor-grid">
              ${renderEditorField('단계', 'phase', draft.phase, 'text', depth === 1, '예: P1000.분석단계')}
              ${renderEditorField('Activity', 'activity', draft.activity, 'text', depth === 2, '예: 요구사항 분석')}
              ${renderEditorField('Task', 'task', draft.task, 'text', depth === 3, '예: 인터뷰 진행')}
              ${renderEditorField('대분류', 'categoryLarge', draft.categoryLarge)}
              ${renderEditorField('중분류', 'categoryMedium', draft.categoryMedium)}
              ${renderEditorField('산출물', 'documentName', draft.documentName)}
              ${renderEditorField('담당자', 'owner', draft.owner)}
              ${renderEditorField('지원팀', 'supportTeam', draft.supportTeam)}
              ${renderEditorField('계획시작일', 'plannedStartDate', draft.plannedStartDate, 'date')}
              ${renderEditorField('계획종료일', 'plannedEndDdate', draft.plannedEndDdate, 'date')}
              ${renderEditorSelectField('실적진척상태', 'actualProgressStatus', draft.actualProgressStatus, ACTUAL_PROGRESS_OPTIONS)}
              ${renderEditorField('실적시작일', 'actualStartDate', draft.actualStartDate, 'date')}
              ${renderEditorField('실적종료일', 'actualEndDate', draft.actualEndDate, 'date')}
            </div>
            <div class="editor-actions">
              <button type="submit" class="primary-button">저장</button>
              <button type="button" class="secondary-button" data-action="cancel-editor">취소</button>
              <div id="editor-errors" class="validation-message"></div>
            </div>
          </form>
        </div>
      </td>
    </tr>
  `;
}

function renderEditorField(label, field, value, type = 'text', required = false, placeholder = '') {
  const testIdMap = {
    phase: 'editor-phase',
    activity: 'editor-activity',
    task: 'editor-task',
    categoryLarge: 'editor-category-large',
    categoryMedium: 'editor-category-medium',
    documentName: 'editor-document-name',
    owner: 'editor-owner',
    supportTeam: 'editor-support-team',
    plannedStartDate: 'editor-planned-start',
    plannedEndDdate: 'editor-planned-end',
    actualStartDate: 'editor-actual-start',
    actualEndDate: 'editor-actual-end'
  };
  const requiredHtml = required ? ' <span class="text-red-500" style="color:var(--danger)">*</span><span class="sr-only">(필수)</span>' : '';
  const requiredAttr = required ? ' required aria-required="true"' : '';
  const placeholderAttr = placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : '';
  return `
    <label class="editor-field">
      <span>${label}${requiredHtml}</span>
      <input data-testid="${testIdMap[field] || `editor-${toKebab(field)}`}" data-editor-field="${field}" type="${type}" value="${escapeHtml(value || '')}"${requiredAttr}${placeholderAttr} />
    </label>
  `;
}

function renderEditorSelectField(label, field, value, options) {
  return `
    <label class="editor-field">
      <span>${label}</span>
      <select data-editor-field="${field}">
        ${options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      </select>
    </label>
  `;
}

function renderTreeCell(value, depth) {
  return `<div class="tree-value indent-${depth}">${value ? escapeHtml(value) : '<span class="empty-cell">-</span>'}</div>`;
}

function renderTextCell(value, warning = '') {
  if (!value) {
    return warning ? `<span class="warning-badge">${escapeHtml(warning)}</span>` : '<span class="empty-cell">-</span>';
  }
  return warning ? `<div>${escapeHtml(value)}<div class="validation-message">${escapeHtml(warning)}</div></div>` : escapeHtml(value);
}

function renderOwnerCell(owner, ownerColorMap) {
  if (!owner) {
    return '<span class="empty-cell">-</span>';
  }
  return `<span class="owner-badge" style="background:${ownerColorMap.get(owner)}">${escapeHtml(owner)}</span>`;
}

function renderStatusCell(progressState) {
  if (!progressState.label) {
    return '<span class="empty-cell">-</span>';
  }
  return `<span class="status-badge ${progressState.className}">${escapeHtml(progressState.label)}</span>`;
}

function renderActualProgressCell(task, taskMetrics) {
  const options = ACTUAL_PROGRESS_OPTIONS.map((option) => `
    <option value="${escapeHtml(option)}" ${task.actualProgressStatus === option ? 'selected' : ''}>${escapeHtml(option)}</option>
  `).join('');
  return `
    <label>
      <span class="sr-only">실적진척상태</span>
      <select data-inline-progress="${escapeHtml(task.id)}">
        ${options}
      </select>
      ${taskMetrics.plannedDateWarning || taskMetrics.actualDateWarning ? `<div class="validation-message">${escapeHtml(taskMetrics.plannedDateWarning || taskMetrics.actualDateWarning)}</div>` : ''}
    </label>
  `;
}

function renderEditorValidation() {
  const errors = validateDraft(state.editor.draft, state.editor.depth);
  state.editor.errors = errors;
  const errorElement = document.getElementById('editor-errors');
  if (errorElement) {
    errorElement.textContent = errors.join(' ');
  }

  const cancelButton = elements.tableBody.querySelector('[data-action="cancel-editor"]');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => closeEditor(), { once: true });
  }
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
}

function closeEditor() {
  state.editor = {
    mode: null,
    targetId: null,
    parentId: null,
    depth: 1,
    insertAfterId: null,
    draft: null,
    errors: []
  };
  renderAll();
}

function saveEditor() {
  const errors = validateDraft(state.editor.draft, state.editor.depth);
  if (errors.length > 0) {
    state.editor.errors = errors;
    renderEditorValidation();
    return;
  }

  if (state.editor.mode === 'edit' && state.editor.targetId) {
    const index = state.tasks.findIndex((task) => task.id === state.editor.targetId);
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
    plannedEndDdate: '',
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
    sanitized[field] = String(draft?.[field] || '').trim();
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
  validateDateField('계획종료일', sanitized.plannedEndDdate, errors);
  validateDateField('실적시작일', sanitized.actualStartDate, errors);
  validateDateField('실적종료일', sanitized.actualEndDate, errors);

  if (sanitized.plannedStartDate && sanitized.plannedEndDdate && compareDateStrings(sanitized.plannedStartDate, sanitized.plannedEndDdate) > 0) {
    errors.push('계획종료일은 계획시작일보다 빠를 수 없습니다.');
  }
  if (sanitized.actualStartDate && sanitized.actualEndDate && compareDateStrings(sanitized.actualStartDate, sanitized.actualEndDate) > 0) {
    errors.push('실적종료일은 실적시작일보다 빠를 수 없습니다.');
  }

  return Array.from(new Set(errors));
}

function validateDateField(label, value, errors) {
  if (!value) {
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${label}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
}

function computeTaskMetrics() {
  const totalDays = state.tasks.reduce((sum, task) => {
    const duration = calculateDurationDays(task.plannedStartDate, task.plannedEndDdate);
    return sum + duration;
  }, 0);

  const baseDate = state.baseDate;
  const byTask = new Map();
  let totalWeightedPlannedRatio = 0;
  let totalWeightedActualRatio = 0;

  state.tasks.forEach((task) => {
    const durationDays = calculateDurationDays(task.plannedStartDate, task.plannedEndDdate);
    const weightRatio = totalDays > 0 ? durationDays / totalDays : 0;
    const plannedProgressRatio = calculatePlannedProgressRatio(baseDate, task.plannedStartDate, task.plannedEndDdate);
    const actualProgressRatio = (ACTUAL_PROGRESS_MAP[task.actualProgressStatus] || 0) / 100;
    const weightedPlannedRatio = weightRatio * plannedProgressRatio;
    const weightedActualRatio = weightRatio * actualProgressRatio;
    const plannedDateWarning = getDateRangeWarning(task.plannedStartDate, task.plannedEndDdate, '계획종료일이 시작일보다 빠릅니다.');
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
  if (!task.plannedStartDate || !task.plannedEndDdate) {
    return { label: '', className: '' };
  }

  if (task.actualStartDate && task.actualEndDate) {
    return { label: '완료', className: 'done' };
  }
  if (compareDateStrings(baseDate, task.plannedEndDdate) >= 0 && (!task.actualStartDate || !task.actualEndDate)) {
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

function calculatePlannedProgressRatio(baseDate, startDate, endDate) {
  if (!baseDate || !startDate || !endDate) {
    return 0;
  }
  if (compareDateStrings(baseDate, startDate) <= 0) {
    return 0;
  }
  if (compareDateStrings(baseDate, endDate) >= 0) {
    return 1;
  }
  const total = calculateDurationDays(startDate, endDate);
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

function getVisibleTasks() {
  const visible = [];
  const hiddenParentIds = new Set();

  // ⚡ Bolt Optimization: Pre-compute task lookup map to avoid O(N²) array scans
  const taskById = new Map();
  state.tasks.forEach((task) => taskById.set(task.id, task));

  state.tasks.forEach((task) => {
    if (hiddenParentIds.has(task.parentId)) {
      hiddenParentIds.add(task.id);
      return;
    }

    visible.push(task);
    if (!task.expanded) {
      hiddenParentIds.add(task.id);
    }
  });

  return visible.filter((task) => {
    let parentId = task.parentId;
    const visited = new Set([task.id]);
    while (parentId) {
      if (visited.has(parentId)) {
        break;
      }
      visited.add(parentId);
      const parent = taskById.get(parentId);
      if (parent && !parent.expanded) {
        return false;
      }
      parentId = parent?.parentId;
    }
    return true;
  });
}

function insertTaskAfter(task, afterId) {
  if (!afterId) {
    state.tasks.unshift(task);
    return;
  }
  const index = state.tasks.findIndex((candidate) => candidate.id === afterId);
  if (index === -1) {
    state.tasks.push(task);
    return;
  }
  state.tasks.splice(index + 1, 0, task);
}

function deleteTaskAndDescendants(taskId) {
  const idsToDelete = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    state.tasks.forEach((task) => {
      if (idsToDelete.has(task.parentId) && !idsToDelete.has(task.id)) {
        idsToDelete.add(task.id);
        changed = true;
      }
    });
  }
  state.tasks = state.tasks.filter((task) => !idsToDelete.has(task.id));
}

function reorderTaskWithinLevel(draggedId, targetId, placeAfter = true) {
  const draggedRange = getTaskSubtreeRange(draggedId);
  const targetRange = getTaskSubtreeRange(targetId);
  if (!draggedRange || !targetRange) {
    return;
  }
  const draggedBlock = state.tasks.slice(draggedRange.startIndex, draggedRange.endIndex + 1);
  state.tasks.splice(draggedRange.startIndex, draggedBlock.length);

  const refreshedTargetRange = getTaskSubtreeRange(targetId);
  const insertionIndex = refreshedTargetRange
    ? (placeAfter ? refreshedTargetRange.endIndex + 1 : refreshedTargetRange.startIndex)
    : state.tasks.length;
  state.tasks.splice(insertionIndex, 0, ...draggedBlock);
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
  const roots = state.tasks.filter((task) => !task.parentId);
  return roots.length > 0 ? getLastDescendantId(roots[roots.length - 1].id) : null;
}

function getLastDescendantId(taskId) {
  const startIndex = state.tasks.findIndex((task) => task.id === taskId);
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
  const startIndex = state.tasks.findIndex((task) => task.id === taskId);
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
  return state.tasks.find((task) => task.id === taskId) || null;
}

function persistState() {
  const payload = {
    projectName: state.projectName,
    baseDate: state.baseDate,
    tasks: state.tasks.map((task) => ({ ...task }))
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

  if (state.jsonSyncHandle) {
    writeJsonSyncFile().catch(() => {
      showToast('연결된 wbs.json 파일 저장에 실패했습니다.');
    });
  }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function hydrateState(savedState) {
  state.projectName = savedState.projectName || DEFAULT_PROJECT_NAME;
  state.baseDate = savedState.baseDate || formatLocalDateInput(new Date());
  state.tasks = Array.isArray(savedState.tasks) ? savedState.tasks.map((task) => ({ ...task, expanded: task.expanded !== false })) : [];
}

async function loadSeedTasks() {
  try {
    const response = await fetch('./wbs.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('seed-load-failed');
    }
    return await response.json();
  } catch {
    return [];
  }
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
    id: task.__id || createId(index + 1),
    parentId: task.__parentId || null,
    depth: Number(task.__depth) || inferDepth(task),
    expanded: true,
    phase: task.phase || '',
    activity: task.activity || '',
    task: task.task || '',
    categoryLarge: task.categoryLarge || '',
    categoryMedium: task.categoryMedium || '',
    documentName: task.documentName || '',
    owner: task.owner || '',
    supportTeam: task.supportTeam || '',
    plannedStartDate: task.plannedStartDate || '',
    plannedEndDdate: task.plannedEndDdate || task.plannedEndDate || '',
    actualProgressStatus: ACTUAL_PROGRESS_MAP[task.actualProgressStatus] !== undefined ? task.actualProgressStatus : '미착수(0%)',
    actualStartDate: task.actualStartDate || '',
    actualEndDate: task.actualEndDate || '',
    pendingDelete: false,
    isSynthetic: Boolean(task.isSynthetic)
  }));
}

function validateImportedTask(task, index) {
  const rowLabel = `${index + 2}행`;
  const plannedStartDate = task.plannedStartDate || '';
  const plannedEndDate = task.plannedEndDdate || task.plannedEndDate || '';
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

  if (plannedStartDate && plannedEndDate && compareDateStrings(plannedStartDate, plannedEndDate) > 0) {
    throw new Error(`${rowLabel}: 계획종료일은 계획시작일보다 빠를 수 없습니다.`);
  }
  if (actualStartDate && actualEndDate && compareDateStrings(actualStartDate, actualEndDate) > 0) {
    throw new Error(`${rowLabel}: 실적종료일은 실적시작일보다 빠를 수 없습니다.`);
  }
}

function buildHierarchicalTasksFromFlatSource(sourceTasks) {
  const normalized = [];
  const phaseMap = new Map();
  const activityMap = new Map();
  const getPhaseKey = (task, index) => task.phase || `__phase-${index}`;
  const getActivityKey = (task, index) => `${getPhaseKey(task, index)}::${task.activity || `__activity-${index}`}`;

  const normalizeExternalRecord = (task, defaults = {}) => ({
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
    plannedEndDdate: task.plannedEndDdate || task.plannedEndDate || '',
    actualProgressStatus: ACTUAL_PROGRESS_MAP[task.actualProgressStatus] !== undefined ? task.actualProgressStatus : '미착수(0%)',
    actualStartDate: task.actualStartDate || '',
    actualEndDate: task.actualEndDate || ''
  });

  const registerPhase = (phaseKey, phaseId) => {
    phaseMap.set(phaseKey, phaseId);
  };

  const registerActivity = (activityKey, activityId) => {
    activityMap.set(activityKey, activityId);
  };

  const ensureSyntheticPhase = (task, index) => {
    const phaseKey = getPhaseKey(task, index);
    if (!phaseMap.has(phaseKey)) {
      const phaseId = createId(`phase-${index}`);
      normalized.push({
        ...normalizeExternalRecord({ phase: task.phase }),
        id: phaseId,
        parentId: null,
        depth: 1,
        expanded: true,
        pendingDelete: false,
        isSynthetic: true
      });
      registerPhase(phaseKey, phaseId);
    }
    return phaseMap.get(phaseKey);
  };

  const ensureSyntheticActivity = (task, index, parentPhaseId) => {
    const key = getActivityKey(task, index);
    if (!activityMap.has(key)) {
      const activityId = createId(`activity-${index}`);
      normalized.push({
        ...normalizeExternalRecord({ phase: task.phase, activity: task.activity }),
        id: activityId,
        parentId: parentPhaseId,
        depth: 2,
        expanded: true,
        pendingDelete: false,
        isSynthetic: true
      });
      registerActivity(key, activityId);
    }
    return activityMap.get(key);
  };

  sourceTasks.forEach((task, index) => {
    const hasPhase = Boolean(task.phase);
    const hasActivity = Boolean(task.activity);
    const hasTask = Boolean(task.task);

    if (hasPhase && !hasActivity && !hasTask) {
      const phaseId = createId(`phase-${index}`);
      normalized.push({
        ...normalizeExternalRecord(task),
        id: phaseId,
        parentId: null,
        depth: 1,
        expanded: true,
        pendingDelete: false,
        isSynthetic: false
      });
      registerPhase(getPhaseKey(task, index), phaseId);
      return;
    }

    const parentPhaseId = ensureSyntheticPhase(task, index);

    if (hasActivity && !hasTask) {
      const activityId = createId(`activity-${index}`);
      normalized.push({
        ...normalizeExternalRecord(task),
        id: activityId,
        parentId: parentPhaseId,
        depth: 2,
        expanded: true,
        pendingDelete: false,
        isSynthetic: false
      });
      registerActivity(getActivityKey(task, index), activityId);
      return;
    }

    const parentActivityId = hasTask ? ensureSyntheticActivity(task, index, parentPhaseId) : parentPhaseId;
    normalized.push({
      ...normalizeExternalRecord(task),
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
      task.plannedEndDdate,
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
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n');
  downloadFile(csvText, `wbs_export_${formatCompactDate(new Date())}.csv`, 'text/csv;charset=utf-8');
}

async function handleCsvImport(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const imported = parseCsv(text);
    state.tasks = validateImportedTasks(normalizeImportedTasks(imported));
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
  return value.substring(0, 1000); // basic length restriction
}
function validateCsvId(value) { return value; }
function validateCsvParentId(value) { return value; }
function validateCsvDepth(value) { return value; }

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

  return rows.slice(1).filter((cells) => cells.some((cell) => cell.trim() !== '')).map((cells) => ({
    phase: validateCsvCell(readCsvCell(cells, headerMap, '단계'), 'phase'),
    activity: validateCsvCell(readCsvCell(cells, headerMap, 'Activity'), 'activity'),
    task: validateCsvCell(readCsvCell(cells, headerMap, 'Task'), 'task'),
    categoryLarge: validateCsvCell(readCsvCell(cells, headerMap, '대분류'), 'categoryLarge'),
    categoryMedium: validateCsvCell(readCsvCell(cells, headerMap, '중분류'), 'categoryMedium'),
    documentName: validateCsvCell(readCsvCell(cells, headerMap, '산출물'), 'documentName'),
    owner: validateCsvCell(readCsvCell(cells, headerMap, '담당자'), 'owner'),
    supportTeam: validateCsvCell(readCsvCell(cells, headerMap, '지원팀'), 'supportTeam'),
    plannedStartDate: validateCsvCell(readCsvCell(cells, headerMap, '계획시작일'), 'plannedStartDate'),
    plannedEndDdate: validateCsvCell(readCsvCell(cells, headerMap, '계획종료일'), 'plannedEndDdate'),
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
  return index === undefined ? '' : (cells[index] || '').trim();
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
    plannedEndDdate: task.plannedEndDdate,
    actualProgressStatus: task.actualProgressStatus,
    actualStartDate: task.actualStartDate,
    actualEndDate: task.actualEndDate
  }));
}

function openGanttModal() {
  elements.ganttModal.classList.remove('hidden');
  renderGantt();
}

function closeGanttModal() {
  elements.ganttModal.classList.add('hidden');
}

function renderGantt() {
  const plannedTasks = state.tasks.filter((task) => isValidDateString(task.plannedStartDate) && isValidDateString(task.plannedEndDdate));
  if (plannedTasks.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'gantt-empty';
    emptyDiv.textContent = '계획 일정이 있는 작업이 없습니다.';
    elements.ganttContent.innerHTML = '';
    elements.ganttContent.appendChild(emptyDiv);
    return;
  }

  const minDate = plannedTasks.reduce((min, task) => (compareDateStrings(task.plannedStartDate, min) < 0 ? task.plannedStartDate : min), plannedTasks[0].plannedStartDate);
  const maxDate = plannedTasks.reduce((max, task) => (compareDateStrings(task.plannedEndDdate, max) > 0 ? task.plannedEndDdate : max), plannedTasks[0].plannedEndDdate);
  const weekdays = buildWeekdayTimeline(minDate, maxDate);
  const weeks = groupTimelineByWeek(weekdays);

  const metaRows = state.tasks.map((task) => `
    <tr>
      <td>${renderTreeCell(task.phase || task.activity || task.task || '-', task.depth)}</td>
      <td>${renderTextCell(task.activity)}</td>
      <td>${renderTextCell(task.task)}</td>
      <td>${renderTextCell(task.categoryLarge)}</td>
      <td>${renderTextCell(task.categoryMedium)}</td>
      <td>${renderTextCell(task.documentName)}</td>
      <td>${renderTextCell(task.owner)}</td>
      <td>${renderTextCell(task.supportTeam)}</td>
      <td>${renderTextCell(task.plannedStartDate)}</td>
      <td>${renderTextCell(task.plannedEndDdate)}</td>
      <td>${renderTextCell(task.actualStartDate)}</td>
      <td>${renderTextCell(task.actualEndDate)}</td>
    </tr>
  `).join('');

  const totalWidth = weekdays.length * 36;
  const chartRows = state.tasks.map((task) => {
    const planBar = createGanttBar(task.plannedStartDate, task.plannedEndDdate, weekdays, 'plan');
    const actualBar = createGanttBar(task.actualStartDate, task.actualEndDate, weekdays, 'actual');
    return `
      <tr>
        <td colspan="${weekdays.length}">
          <div class="gantt-day-track" style="width:${totalWidth}px">
            ${planBar}
            ${actualBar}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  elements.ganttContent.innerHTML = `
    <div class="gantt-shell">
      <div class="gantt-meta">
        <table>
          <thead>
            <tr>
              <th>단계</th>
              <th>Activity</th>
              <th>Task</th>
              <th>대분류</th>
              <th>중분류</th>
              <th>산출물</th>
              <th>담당자</th>
              <th>지원팀</th>
              <th>계획시작일</th>
              <th>계획종료일</th>
              <th>실적시작일</th>
              <th>실적종료일</th>
            </tr>
          </thead>
          <tbody>${metaRows}</tbody>
        </table>
      </div>
      <div class="gantt-chart">
        <table>
          <thead>
            <tr>
              ${weeks.map((week) => `<th class="gantt-week-header" colspan="${week.days.length}">${escapeHtml(week.label)}</th>`).join('')}
            </tr>
            <tr>
              ${weekdays.map((day) => `<th class="gantt-day-cell">${escapeHtml(day.dayLabel)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${chartRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function buildWeekdayTimeline(minDate, maxDate) {
  const days = [];
  let cursor = getMonday(minDate);
  const endBoundary = getFriday(maxDate);
  while (compareDateStrings(cursor, endBoundary) <= 0) {
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
  const groups = [];
  days.forEach((day) => {
    const monday = getMonday(day.date);
    const existing = groups.find((group) => group.monday === monday);
    if (existing) {
      existing.days.push(day);
    } else {
      groups.push({
        monday,
        label: `${monday.slice(5, 7)}월 ${monday.slice(8, 10)}일 주간`,
        days: [day]
      });
    }
  });
  return groups;
}

function createGanttBar(startDate, endDate, weekdays, type) {
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return '';
  }
  const startIndex = weekdays.findIndex((day) => compareDateStrings(day.date, startDate) >= 0);
  // ⚡ Bolt: Replace O(N) array clone+reverse with reverse loop to avoid O(T*D) memory allocations in Gantt render
  let normalizedEndIndex = -1;
  for (let i = weekdays.length - 1; i >= 0; i -= 1) {
    if (compareDateStrings(weekdays[i].date, endDate) <= 0) {
      normalizedEndIndex = i;
      break;
    }
  }

  if (startIndex === -1 || normalizedEndIndex === -1) {
    return '';
  }
  if (normalizedEndIndex < startIndex) {
    return '';
  }
  return `<div class="gantt-bar ${type}" style="left:${startIndex * 36}px;width:${(normalizedEndIndex - startIndex + 1) * 36}px"></div>`;
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
  elements.tableBody.querySelectorAll('.dragging').forEach((row) => row.classList.remove('dragging'));
  clearDropTargets();
}

function clearDropTargets() {
  elements.tableBody.querySelectorAll('.drop-target').forEach((row) => {
    row.classList.remove('drop-target');
    delete row.dataset.dropPosition;
  });
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  let normalized = String(value ?? '');
  if (/^\s*[=+\-@]/.test(normalized)) {
    normalized = `\t${normalized}`;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

function createId(seed = Date.now()) {
  // Security enhancement: Prefer crypto.randomUUID for stronger randomness
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `task-${crypto.randomUUID()}`;
  }
  return `task-${seed}-${Math.random().toString(16).slice(2, 8)}`;
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return formatDateInput(new Date(dateStringToUtcMs(value))) === value;
}

function dateStringToUtcMs(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
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

// ⚡ Bolt optimization: Use inline ternary string concatenation instead of String.padStart()
// to avoid unnecessary string allocations and JS-to-C++ overhead in hot loops.
function formatDateInput(date) {
  const year = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return `${year}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`;
}

// ⚡ Bolt optimization: Use inline ternary string concatenation instead of String.padStart()
function formatLocalDateInput(date) {
  const year = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${year}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`;
}

// ⚡ Bolt optimization: Use inline ternary string concatenation instead of String.padStart()
function formatCompactDate(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${date.getFullYear()}${m < 10 ? '0' + m : m}${d < 10 ? '0' + d : d}`;
}

function formatPercent(value, digits) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function formatDecimal(value, digits) {
  return Number(value || 0).toFixed(digits);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toKebab(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}
