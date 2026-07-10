// Shared fast-check arbitraries for the ScopeWeave fuzz targets.
import fc from 'fast-check';

// Strings crafted to probe the sanitizers/validators: CSV-formula prefixes,
// HTML metacharacters, control chars, quotes/commas/newlines (CSV structure),
// unicode, and the prototype-pollution keys.
export const nastyString = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom(
    '=1+1',
    '+cmd',
    '-2',
    '@SUM(A1)',
    '|cat',
    '\t=danger',
    '<script>',
    '</b>',
    '"quoted, value"',
    'a,b,c',
    'line1\nline2',
    'line1\r\nline2',
    '﻿BOM',
    '__proto__',
    'constructor',
    'prototype',
    'x'.repeat(1001),
    '\u0000\u0001',
    '2024-02-30',
    '2024-13-01',
    '9999-99-99'
  )
);

// A date-ish value: sometimes a real calendar date, sometimes garbage.
export const dateish = fc.oneof(
  fc.constantFrom('2024-01-01', '2023-12-31', '2024-02-29', ''),
  fc.constantFrom('2024-13-40', '2024-02-30', 'not-a-date', '99999-1-1'),
  nastyString
);

// A single "task"-shaped record with mostly-optional fields, mirroring the
// keys the importer reads. Values are deliberately hostile.
export const taskRecordArb = fc.record(
  {
    phase: nastyString,
    activity: nastyString,
    task: nastyString,
    categoryLarge: nastyString,
    categoryMedium: nastyString,
    documentName: nastyString,
    owner: nastyString,
    supportTeam: nastyString,
    actualProgressStatus: fc.oneof(
      fc.constantFrom('미착수(0%)', '진행(50%)', 'PM확인(100%)'),
      nastyString
    ),
    plannedStartDate: dateish,
    plannedEndDate: dateish,
    actualStartDate: dateish,
    actualEndDate: dateish,
    __id: fc.oneof(fc.string(), fc.constant(undefined)),
    __parentId: fc.oneof(fc.string(), fc.constant(undefined)),
    __depth: fc.oneof(
      fc.constantFrom('1', '2', '3', '0', '4', 'x', ''),
      fc.integer({ min: -5, max: 9 })
    ),
    isSynthetic: fc.boolean(),
  },
  { requiredKeys: [] }
);

// Arbitrary array of task records (the normalizeImportedTasks input).
export const taskArrayArb = fc.array(taskRecordArb, { maxLength: 30 });

// Fully-arbitrary values, including non-object garbage, to hammer the mappers
// with input they are never "supposed" to receive (e.g. a hand-edited wbs.json).
export const anyJsonValue = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.string(),
  taskRecordArb,
  fc.array(fc.oneof(fc.constant(null), fc.integer(), fc.string(), taskRecordArb), {
    maxLength: 20,
  })
);

// Build a syntactically-valid CSV header + arbitrary body rows, so the fuzzer
// actually reaches the per-cell mapping/validation code (not just the
// "missing required column" early-out).
const REQUIRED_HEADERS = [
  '단계',
  'Activity',
  'Task',
  '대분류',
  '중분류',
  '산출물',
  '담당자',
  '지원팀',
  '실적진척상태',
  '계획시작일',
  '계획종료일',
  '실적시작일',
  '실적종료일',
];

export const wellHeaderedCsv = fc
  .array(fc.array(nastyString, { maxLength: REQUIRED_HEADERS.length + 3 }), {
    maxLength: 15,
  })
  .map((rows) => {
    const header = REQUIRED_HEADERS.join(',');
    const body = rows
      .map((cells) =>
        cells
          .map((c) => `"${String(c).replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');
    return `${header}\n${body}`;
  });
