const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const replacement = `
let ganttMetaRowTemplate = null;

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

  if (!ganttMetaRowTemplate) {
    ganttMetaRowTemplate = document.createElement('tr');
  }

  state.tasks.forEach((task) => {
    const row = ganttMetaRowTemplate.cloneNode(false);
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
`;

code = code.replace(/function createGanttMetaTable\([\s\S]*?return table;\n\}/, replacement.trim());

fs.writeFileSync('app.js', code);
