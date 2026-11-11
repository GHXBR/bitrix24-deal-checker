const config = require('../config');
const { sanitizeSourceEntries } = require('../src/utils');
const {
  parseDealAmountFromTitle,
  extractAcquiringFeesFromComments,
} = require('../src/moneySources');

let fail = 0;
function assert(name, cond, detail) {
  if (cond) console.log('OK  ', name);
  else {
    fail++;
    console.log('FAIL', name, detail || '');
  }
}

assert('title 2900', parseDealAmountFromTitle('Нал-Ю26-2900') === 2900);
assert('title 4800', parseDealAmountFromTitle('Нал-Ю26-4800') === 4800);
assert('title 27500', parseDealAmountFromTitle('Нал-Ю26-27500') === 27500);

const acq = extractAcquiringFeesFromComments([], 2900, [87, 595.98]);
assert('acq from field 87', acq.length === 1 && acq[0].amount === 87 && acq[0].fromField);

const acq2 = extractAcquiringFeesFromComments([], 27500, [825, 28500]);
assert('acq from field 825', acq2.length === 1 && acq2[0].amount === 825);

const acq3 = extractAcquiringFeesFromComments([], 53100, [50922.19]);
assert('acq absent if no 3% in fields/comments', acq3.length === 0);

const s = sanitizeSourceEntries(
  [
    { amount: 70455, origin: 'a' },
    { amount: 1433.51, origin: 'b' },
    { amount: 18, origin: 'junk' },
  ],
  [1433.51, 70455],
  config
);
assert(
  'drop 18',
  s.dropped.some((d) => d.amount === 18) && !s.kept.some((k) => k.amount === 18),
  JSON.stringify(s)
);

const s2 = sanitizeSourceEntries(
  [
    { amount: 595.98, origin: 'pay' },
    { amount: 54.52, origin: 'junk' },
    { amount: 87, origin: 'acq' },
  ],
  [87, 595.98],
  config
);
assert(
  'keep acq+pay drop 54.52',
  s2.kept.map((k) => k.amount).sort((a, b) => a - b).join(',') === '87,595.98' &&
    s2.dropped.some((d) => d.amount === 54.52),
  JSON.stringify(s2)
);

process.exit(fail ? 1 : 0);
