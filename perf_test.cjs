const { performance } = require('perf_hooks');

function formatDateInput_pad(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateInput_ternary(date) {
  const year = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const month = m < 10 ? '0' + m : m;
  const day = d < 10 ? '0' + d : d;
  return `${year}-${month}-${day}`;
}

const dates = Array.from({length: 10000}, () => new Date(Date.now() - Math.random() * 10000000000));

let start = performance.now();
for(let i=0; i<100; i++) {
  for(const date of dates) {
    formatDateInput_pad(date);
  }
}
let end = performance.now();
console.log(`padStart: ${end - start}ms`);

start = performance.now();
for(let i=0; i<100; i++) {
  for(const date of dates) {
    formatDateInput_ternary(date);
  }
}
end = performance.now();
console.log(`ternary: ${end - start}ms`);
