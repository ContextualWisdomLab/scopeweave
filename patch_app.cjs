const fs = require('fs');
const content = fs.readFileSync('app.js', 'utf8');
const search = `  if (action === 'delete') {
    if (window.confirm(\`'\${task.task || task.activity || task.phase || '선택한 작업'}' 항목과 모든 하위 작업을 삭제하시겠습니까?\`)) {
      const visibleTasksBefore = getVisibleTasks();
      const currentIndex = visibleTasksBefore.findIndex(t => t.id === taskId);

      deleteTaskAndDescendants(taskId);`;
const replace = `  if (action === 'delete') {
    if (window.confirm(\`'\${task.task || task.activity || task.phase || '선택한 작업'}' 항목과 모든 하위 작업을 삭제하시겠습니까?\`)) {
      const visibleTasksBefore = getVisibleTasks();
      let currentIndex = -1;
      for (let i = 0; i < visibleTasksBefore.length; i++) {
        if (visibleTasksBefore[i].id === taskId) {
          currentIndex = i;
          break;
        }
      }

      deleteTaskAndDescendants(taskId);`;
fs.writeFileSync('app.js', content.replace(search, replace), 'utf8');
