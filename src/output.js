const fs = require('fs');
const path = require('path');
const { formatMoney } = require('./utils');

function ensureResultsDir() {
  const dir = path.join(process.cwd(), 'results');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function escapeCsv(value) {
  const s = String(value ?? '');
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function getIssues(result) {
  if (result.issues?.length) return result.issues;
  return (result.errors || []).map((e) => ({ problem: e, fix: '' }));
}

function buildCsvContent(results) {
  const header = [
    'ID',
    'Название',
    'Ссылка',
    'Статус',
    'Что не так',
    'Что исправить',
    'Месяц завершения',
    'Счёт заказчику',
    'Файл счёта заказчику',
    'Суммы из задач',
    'Суммы в графах затрат',
  ];

  const lines = [header.join(';')];
  for (const r of results) {
    const issues = getIssues(r);
    const problems = issues.map((i, idx) => `${idx + 1}) ${i.problem}`).join(' || ');
    const fixes = issues.map((i, idx) => `${idx + 1}) ${i.fix}`).join(' || ');

    lines.push(
      [
        r.id,
        r.details?.dealName || r.title,
        r.url,
        r.ok ? 'OK' : 'НУЖНО ИСПРАВИТЬ',
        problems,
        fixes,
        r.details?.closeMonth || '',
        r.details?.clientInvoice?.skipped
          ? 'не требуется'
          : r.details?.clientInvoice?.found
            ? 'да'
            : 'нет',
        r.details?.clientInvoice?.fileName || '',
        (r.details?.sourceAmounts || []).map(formatMoney).join(', '),
        (r.details?.fieldAmounts || []).map(formatMoney).join(', '),
      ]
        .map(escapeCsv)
        .join(';')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}

function writeCsv(results, { final = false } = {}) {
  const dir = ensureResultsDir();
  const latest = path.join(dir, 'check_latest.csv');
  const content = buildCsvContent(results);
  fs.writeFileSync(latest, content, 'utf8');
  // полный снимок с датой — только в конце прогона
  if (final) {
    fs.writeFileSync(path.join(dir, `check_${stamp()}.csv`), content, 'utf8');
  }
  return latest;
}

function printDealIssues(result) {
  const issues = getIssues(result);
  if (!issues.length) return;
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    console.log(`  ${i + 1}. Что не так: ${issue.problem}`);
    if (issue.fix) console.log(`     Что сделать: ${issue.fix}`);
  }
}

function printSummary(results) {
  const bad = results.filter((r) => !r.ok);
  const good = results.filter((r) => r.ok);

  console.log('\n—— Итог ——');
  console.log(`Всего: ${results.length} | OK: ${good.length} | Исправить: ${bad.length}`);

  if (!bad.length) {
    console.log('Все проверенные сделки в порядке.\n');
    return;
  }

  console.log('\nПроблемные сделки:');
  for (const r of bad) {
    console.log(`\n[#${r.id}] ${r.details?.dealName || r.title}`);
    console.log(`  ${r.url}`);
    printDealIssues(r);
  }
  console.log('');
}

module.exports = {
  writeCsv,
  printSummary,
  printDealIssues,
};
