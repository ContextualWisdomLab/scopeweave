const fs = require('fs');
const content = fs.readFileSync('cloud-sync.js', 'utf8');
const search = `        const taskNames = hit.tasks.map((t) => t.name).join(', ');
        who.textContent = hit.nameMatch && !taskNames ? hit.projectName : \`\${hit.projectName} — \${taskNames}\`;
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'secondary-button';
        open.textContent = '열기';
        open.addEventListener('click', async () => {
          modal.classList.add('hidden');
          await openProject(hit.projectId).catch((err) => toast(err.message));
        });`;
console.log(content.includes(search));
