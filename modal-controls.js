// Shared modal-close semantics for dynamically rendered cloud controls.
// Resolve from the clicked descendant rather than relying on event.target
// carrying the close marker itself, so icon clicks behave like button clicks.
document.addEventListener('click', (event) => {
  const teamClose = event.target.closest('[data-team-close="true"]');
  if (!teamClose) return;
  teamClose.closest('.modal').classList.add('hidden');
});
