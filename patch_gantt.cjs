const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const replacement = `
let ganttRowTemplate = null;
let ganttCellTemplate = null;
let ganttTrackTemplate = null;
let ganttBarTemplate = null;

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

  if (!ganttRowTemplate) {
    ganttRowTemplate = document.createElement('tr');
    ganttCellTemplate = document.createElement('td');
    ganttTrackTemplate = document.createElement('div');
    ganttTrackTemplate.className = 'gantt-day-track';
  }

  state.tasks.forEach((task) => {
    const row = ganttRowTemplate.cloneNode(false);
    const cell = ganttCellTemplate.cloneNode(false);
    cell.colSpan = weekdays.length;

    const track = ganttTrackTemplate.cloneNode(false);
    track.style.width = \`\${totalWidth}px\`;

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
`;

code = code.replace(/function createGanttChartTable\([\s\S]*?return table;\n\}/, replacement.trim());

const barReplacement = `
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

  if (!ganttBarTemplate) {
    ganttBarTemplate = document.createElement('div');
    ganttBarTemplate.setAttribute('role', 'img');
    ganttBarTemplate.tabIndex = 0;
  }

  const bar = ganttBarTemplate.cloneNode(false);
  bar.className = \`gantt-bar \${type}\`;
  bar.style.left = \`\${startIndex * 36}px\`;
  bar.style.width = \`\${(normalizedEndIndex - startIndex + 1) * 36}px\`;

  const taskName = task.task || task.activity || task.phase || '작업';
  const typeLabel = type === 'plan' ? '계획' : '실적';
  const visibleStartDate = weekdays[startIndex].date;
  const visibleEndDate = weekdays[normalizedEndIndex].date;
  const tooltipText = \`\${taskName} \${typeLabel} (\${visibleStartDate} ~ \${visibleEndDate})\`;

  bar.title = tooltipText;
  bar.setAttribute('aria-label', tooltipText);

  return bar;
}
`;

code = code.replace(/function createGanttBarElement\([\s\S]*?return bar;\n\}/, barReplacement.trim());

fs.writeFileSync('app.js', code);
