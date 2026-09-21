const fs = require('fs');
const content = fs.readFileSync('analytics.js', 'utf8');
const search = `  // actual EV marker at baseDate x-position (nearest timeline index)
  let idx = series.timeline.findIndex((d) => d >= baseDate);
  if (idx === -1) idx = n - 1;`;
console.log("Found in analytics.js:", content.includes(search));

const appJs = fs.readFileSync('app.js', 'utf8');
const appSearch = `  if (action === 'delete') {
    if (window.confirm(\`'\${task.task || task.activity || task.phase || '선택한 작업'}' 항목과 모든 하위 작업을 삭제하시겠습니까?\`)) {
      const visibleTasksBefore = getVisibleTasks();
      const currentIndex = visibleTasksBefore.findIndex(t => t.id === taskId);

      deleteTaskAndDescendants(taskId);`;
console.log("Found in app.js:", appJs.includes(appSearch));
