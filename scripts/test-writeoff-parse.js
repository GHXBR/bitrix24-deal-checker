const fs = require('fs');
const path = require('path');
const vm = require('vm');
const config = require('../config');
const { parseMoney, isPlausibleMoney } = require('../src/utils');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'deal.js'), 'utf8');
const start = src.indexOf('function extractWriteOffAmountFromText');
if (start < 0) throw new Error('function not found');
const next = src.indexOf('\nfunction extract', start + 10);
const next2 = src.indexOf('\nasync function ', start + 10);
const next3 = src.indexOf('\nmodule.exports', start + 10);
const end = Math.min(...[next, next2, next3].filter((n) => n > 0));
const fnSrc = src.slice(start, end);

const sandbox = {
  config,
  parseMoney,
  isPlausibleMoney,
  logWarn() {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(`${fnSrc}\nthis.fn = extractWriteOffAmountFromText;`, sandbox);

const samples = [
  ['Цена: 100\nСумма: 1 250', 1250],
  ['цена 99.5', null],
  ['Всего к списанию: 3400', 3400],
  ['на сумму 500.50', 500.5],
  ['Цена 200 Сумма 900', 900],
  ['Итого цена 50', null],
  ['сумма 297.99', 297.99],
  ['всего 10 000', 10000],
  ['Товар А цена 15\nТовар Б цена 20\nвсего 35', 35],
];

let fail = 0;
for (const [t, expect] of samples) {
  const got = sandbox.fn(t, []);
  const ok = Object.is(got, expect) || got === expect;
  if (!ok) fail++;
  console.log(ok ? 'OK  ' : 'FAIL', JSON.stringify(t), '=>', got, 'want', expect);
}
process.exit(fail ? 1 : 0);
