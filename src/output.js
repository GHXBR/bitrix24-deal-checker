const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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
  if (result.issues?.length) {
    return result.issues.map((issue) => ({
      comment: issue.comment || issue.problem || 'нужно исправить',
      detail: issue.detail || issue.problem || issue.fix || '',
    }));
  }
  return (result.errors || []).map((e) => ({
    comment: 'нужно исправить',
    detail: String(e),
  }));
}

function formatComment(result) {
  const seen = [];
  for (const issue of getIssues(result)) {
    const comment = String(issue.comment || '').trim();
    if (comment && !seen.includes(comment)) seen.push(comment);
  }
  return seen.join('; ');
}

function formatDetails(result) {
  const issues = getIssues(result);
  if (!issues.length) return '';
  if (issues.length === 1) return issues[0].detail || '';
  return issues.map((issue, idx) => `${idx + 1}) ${issue.detail}`).join('\n');
}

function clientInvoiceText(r) {
  if (r.details?.clientInvoice?.skipped) return 'не требуется';
  if (r.details?.clientInvoice?.found) return 'да';
  return 'нет';
}

function buildCsvContent(results) {
  const header = [
    'ID',
    'Название',
    'Ссылка',
    'Статус',
    'Комментарий',
    'Месяц завершения',
    'Счёт заказчику',
    'Файл счёта заказчику',
    'Суммы из задач',
    'Суммы в графах затрат',
    'Подробно',
  ];

  const lines = [header.join(';')];
  for (const r of results) {
    lines.push(
      [
        r.id,
        r.details?.dealName || r.title,
        r.url,
        r.ok ? 'OK' : 'НУЖНО ИСПРАВИТЬ',
        r.ok ? '' : formatComment(r),
        r.details?.closeMonth || '',
        clientInvoiceText(r),
        r.details?.clientInvoice?.fileName || '',
        (r.details?.sourceAmounts || []).map(formatMoney).join(', '),
        (r.details?.fieldAmounts || []).map(formatMoney).join(', '),
        r.ok ? '' : formatDetails(r),
      ]
        .map(escapeCsv)
        .join(';')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}

/** Строки для листа «Нужно исправить»: одна строка = одна сделка. */
function buildFixRows(results) {
  const rows = [];
  for (const r of results) {
    if (r.ok) continue;
    rows.push({
      id: r.id,
      name: r.details?.dealName || r.title || '',
      url: r.url || '',
      comment: formatComment(r) || 'нужно исправить',
      detail: formatDetails(r) || 'Детали замечания не разобраны',
      closeMonth: r.details?.closeMonth || '',
      clientInvoice: clientInvoiceText(r),
      sourceAmounts: (r.details?.sourceAmounts || []).map(formatMoney).join(', '),
      fieldAmounts: (r.details?.fieldAmounts || []).map(formatMoney).join(', '),
    });
  }
  return rows;
}

function buildAllRows(results) {
  return results.map((r) => ({
    id: r.id,
    name: r.details?.dealName || r.title || '',
    url: r.url || '',
    status: r.ok ? 'OK' : 'НУЖНО ИСПРАВИТЬ',
    comment: r.ok ? '' : formatComment(r),
    detail: r.ok ? '' : formatDetails(r),
    closeMonth: r.details?.closeMonth || '',
    clientInvoice: clientInvoiceText(r),
    invoiceFile: r.details?.clientInvoice?.fileName || '',
    sourceAmounts: (r.details?.sourceAmounts || []).map(formatMoney).join(', '),
    fieldAmounts: (r.details?.fieldAmounts || []).map(formatMoney).join(', '),
  }));
}

function writeExcel(results, { final = false } = {}) {
  const XLSX = require('xlsx');
  const dir = ensureResultsDir();
  const fixRows = buildFixRows(results);
  const allRows = buildAllRows(results);

  const fixSheet = XLSX.utils.json_to_sheet(
    fixRows.length
      ? fixRows.map((r) => ({
          ID: r.id,
          Название: r.name,
          Ссылка: r.url,
          Комментарий: r.comment,
          'Месяц завершения': r.closeMonth,
          'Счёт заказчику': r.clientInvoice,
          'Суммы из задач': r.sourceAmounts,
          'Суммы в графах': r.fieldAmounts,
          Подробно: r.detail,
        }))
      : [
          {
            ID: '',
            Название: 'Проблемных сделок нет',
            Ссылка: '',
            Комментарий: '',
            'Месяц завершения': '',
            'Счёт заказчику': '',
            'Суммы из задач': '',
            'Суммы в графах': '',
            Подробно: '',
          },
        ]
  );

  const allSheet = XLSX.utils.json_to_sheet(
    allRows.map((r) => ({
      ID: r.id,
      Название: r.name,
      Ссылка: r.url,
      Статус: r.status,
      Комментарий: r.comment,
      'Месяц завершения': r.closeMonth,
      'Счёт заказчику': r.clientInvoice,
      'Файл счёта': r.invoiceFile,
      'Суммы из задач': r.sourceAmounts,
      'Суммы в графах': r.fieldAmounts,
      Подробно: r.detail,
    }))
  );

  const summarySheet = XLSX.utils.aoa_to_sheet([
    ['Проверка сделок Битрикс24'],
    ['Дата', new Date().toLocaleString('ru-RU')],
    ['Всего сделок', results.length],
    ['OK', results.filter((r) => r.ok).length],
    ['Нужно исправить', results.filter((r) => !r.ok).length],
    ['Сделок с замечаниями', fixRows.length],
    [],
    ['Колонка «Комментарий» — коротко, что не так.'],
    ['Последняя колонка «Подробно» — какие суммы и поля не сошлись.'],
    ['Лист «Нужно исправить» — одна строка = одна сделка.'],
    ['Лист «Все сделки» — полный список проверенных сделок.'],
  ]);

  // ширины колонок для удобного чтения в Excel
  fixSheet['!cols'] = [
    { wch: 10 },
    { wch: 28 },
    { wch: 42 },
    { wch: 52 },
    { wch: 18 },
    { wch: 16 },
    { wch: 28 },
    { wch: 28 },
    { wch: 72 },
  ];
  allSheet['!cols'] = [
    { wch: 10 },
    { wch: 28 },
    { wch: 42 },
    { wch: 18 },
    { wch: 52 },
    { wch: 18 },
    { wch: 16 },
    { wch: 36 },
    { wch: 28 },
    { wch: 28 },
    { wch: 72 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Итог');
  XLSX.utils.book_append_sheet(wb, fixSheet, 'Нужно исправить');
  XLSX.utils.book_append_sheet(wb, allSheet, 'Все сделки');

  const latest = path.join(dir, 'check_latest.xlsx');
  XLSX.writeFile(wb, latest);
  if (final) {
    XLSX.writeFile(wb, path.join(dir, `check_${stamp()}.xlsx`));
  }
  return latest;
}

function writeCsv(results, { final = false } = {}) {
  const dir = ensureResultsDir();
  const latest = path.join(dir, 'check_latest.csv');
  const content = buildCsvContent(results);
  fs.writeFileSync(latest, content, 'utf8');
  if (final) {
    fs.writeFileSync(path.join(dir, `check_${stamp()}.csv`), content, 'utf8');
  }
  return latest;
}

/** CSV + Excel. Возвращает путь к .xlsx (основной отчёт). */
function writeReport(results, { final = false } = {}) {
  writeCsv(results, { final });
  return writeExcel(results, { final });
}

function openReport(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', filePath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // ignore
  }
}

function printDealIssues(result) {
  const issues = getIssues(result);
  if (!issues.length) return;
  const detail = formatDetails(result);
  for (const line of detail.split('\n')) {
    console.log(`  ${line}`);
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
    console.log(`\n[#${r.id}] ${r.details?.dealName || r.title} — ${formatComment(r)}`);
    console.log(`  ${r.url}`);
    printDealIssues(r);
  }
  console.log('');
}

module.exports = {
  writeCsv,
  writeExcel,
  writeReport,
  openReport,
  printSummary,
  printDealIssues,
  formatComment,
};
