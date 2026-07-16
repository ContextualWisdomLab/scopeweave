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
    ganttMetaRowTemplate.append(
      createTableCell(''), createTableCell(''), createTableCell(''), createTableCell(''),
      createTableCell(''), createTableCell(''), createTableCell(''), createTableCell(''),
      createTableCell(''), createTableCell(''), createTableCell(''), createTableCell('')
    );
  }

  state.tasks.forEach((task) => {
    const row = ganttMetaRowTemplate.cloneNode(true);
    row.children[0].appendChild(createTreeCellContent(task.phase || task.activity || task.task || '-', task.depth));
    row.children[1].appendChild(createTextCellContent(task.activity));
    row.children[2].appendChild(createTextCellContent(task.task));
    row.children[3].appendChild(createTextCellContent(task.categoryLarge));
    row.children[4].appendChild(createTextCellContent(task.categoryMedium));
    row.children[5].appendChild(createTextCellContent(task.documentName));
    row.children[6].appendChild(createTextCellContent(task.owner));
    row.children[7].appendChild(createTextCellContent(task.supportTeam));
    row.children[8].appendChild(createTextCellContent(task.plannedStartDate));
    row.children[9].appendChild(createTextCellContent(task.plannedEndDate));
    row.children[10].appendChild(createTextCellContent(task.actualStartDate));
    row.children[11].appendChild(createTextCellContent(task.actualEndDate));

    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  return table;
}
`;

code = code.replace(/let ganttMetaRowTemplate = null;[\s\S]*?function createGanttMetaTable\([\s\S]*?return table;\n\}/, replacement.trim());

fs.writeFileSync('app.js', code);
