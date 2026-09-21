const fs = require('fs');
const content = fs.readFileSync('app.js', 'utf8');
const search = `  const taskById = new Map(tasks.map(t => [t.id, t]));
  for (const task of tasks) {
    let current = task.parentId;
    const visited = new Set([task.id]);
    while (current) {
      if (visited.has(current)) {
        throw new Error(\`순환 참조가 발견되었습니다: \${task.id}\`);
      }
      visited.add(current);
      const parentTask = taskById.get(current);
      current = parentTask ? parentTask.parentId : null;
    }
  }`;

console.log("Found:", content.includes(search));
