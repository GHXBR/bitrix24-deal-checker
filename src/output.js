const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fmt = (n) => (n == null || !Number.isFinite(n) ? '' : String(n));

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
  if (r.details?.clientInvoice?.found) {
    const amount = r.details.clientInvoice.amount;
    return amount != null ? `да (${fmt(amount)})` : 'да';
  }
  return 'нет';
}

function statusText(r) {
  if (r.ok) return 'OK';
  if (r.checkFailed) return 'НЕ УДАЛОСЬ ПРОВЕРИТЬ';
  return 'НУЖНО ИСПРАВИТЬ';
}

function sourceText(r) {
  if (r.details?.sourceOrigins) return r.details.sourceOrigins;
  return (r.details?.sourceAmounts || []).map(fmt).join(', ');
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
        statusText(r),
        r.ok ? '' : formatComment(r),
        r.details?.closeMonth || '',
        clientInvoiceText(r),
        r.details?.clientInvoice?.fileName || '',
        sourceText(r),
        (r.details?.fieldAmounts || []).map(fmt).join(', '),
        r.ok ? '' : formatDetails(r),
      ]
        .map(escapeCsv)
        .join(';')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}

/**
 * Лист «Нужно исправить»: одна строка = одно замечание.
 * Так удобнее править в Битриксе по списку.
 */
function buildFixRows(results) {
  const rows = [];
  for (const r of results) {
    if (r.ok) continue;
    const name = r.details?.dealName || r.title || '';
    const issues = getIssues(r);
    if (!issues.length) {
      rows.push({
        id: r.id,
        name,
        url: r.url || '',
        comment: formatComment(r) || 'нужно исправить',
        detail: 'Детали замечания не разобраны',
      });
      continue;
    }
    for (const issue of issues) {
      rows.push({
        id: r.id,
        name,
        url: r.url || '',
        comment: String(issue.comment || '').trim() || 'нужно исправить',
        detail: String(issue.detail || '').trim() || String(issue.comment || '').trim(),
      });
    }
  }
  return rows;
}

function buildAllRows(results) {
  return results.map((r) => ({
    id: r.id,
    name: r.details?.dealName || r.title || '',
    url: r.url || '',
    status: statusText(r),
    comment: r.ok ? '' : formatComment(r),
    closeMonth: r.details?.closeMonth || '',
    clientInvoice: clientInvoiceText(r),
  }));
}

function setColWidths(sheet, widths) {
  sheet['!cols'] = widths.map((wch) => ({ wch }));
}

function writeExcel(results, { final = false } = {}) {
  const XLSX = require('xlsx');
  const dir = ensureResultsDir();
  const fixRows = buildFixRows(results);
  const allRows = buildAllRows(results);

  const fixSheet = XLSX.utils.json_to_sheet(
    fixRows.length
      ? fixRows.map((r, idx) => ({
          '№': idx + 1,
          ID: r.id,
          Сделка: r.name,
          'Что не так': r.comment,
          Подробно: r.detail,
          Ссылка: r.url,
        }))
      : [
          {
            '№': '',
            ID: '',
            Сделка: 'Проблемных сделок нет',
            'Что не так': '',
            Подробно: '',
            Ссылка: '',
          },
        ]
  );

  const allSheet = XLSX.utils.json_to_sheet(
    allRows.map((r, idx) => ({
      '№': idx + 1,
      ID: r.id,
      Сделка: r.name,
      Статус: r.status,
      Комментарий: r.comment,
      'Месяц завершения': r.closeMonth,
      'Счёт заказчику': r.clientInvoice,
      Ссылка: r.url,
    }))
  );

  setColWidths(fixSheet, [6, 10, 36, 36, 70, 46]);
  setColWidths(allSheet, [6, 10, 36, 20, 40, 16, 16, 46]);

  // Без листа «Итог»: сразу рабочая таблица замечаний.
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, fixSheet, 'Нужно исправить');
  XLSX.utils.book_append_sheet(wb, allSheet, 'Все сделки');

  const latest = path.join(dir, 'check_latest.xlsx');
  const writeSafe = (file) => {
    try {
      XLSX.writeFile(wb, file);
      return file;
    } catch (err) {
      if (!/EBUSY|EPERM|locked/i.test(String(err && err.message))) throw err;
      const alt = file.replace(/\.xlsx$/i, `_${Date.now()}.xlsx`);
      XLSX.writeFile(wb, alt);
      return alt;
    }
  };
  const written = writeSafe(latest);
  if (final) writeSafe(path.join(dir, `check_${stamp()}.xlsx`));
  return written;
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
  const bad = results.filter((r) => !r.ok && !r.checkFailed);
  const failed = results.filter((r) => r.checkFailed);
  const good = results.filter((r) => r.ok);

  console.log('\n—— Итог ——');
  console.log(
    `Всего: ${results.length} | OK: ${good.length} | Исправить: ${bad.length} | Не проверено: ${failed.length}`
  );

  if (!bad.length) {
    console.log('Все проверенные сделки в порядке.\n');
    return;
  }

  if (bad.length) {
    console.log('\nПроблемные сделки:');
    for (const r of bad) {
      console.log(`\n[#${r.id}] ${r.details?.dealName || r.title} — ${formatComment(r)}`);
      console.log(`  ${r.url}`);
      printDealIssues(r);
    }
  }
  if (failed.length) {
    console.log('\nНе удалось проверить:');
    for (const r of failed) {
      console.log(`\n[#${r.id}] ${r.details?.dealName || r.title} — ${formatComment(r)}`);
      console.log(`  ${r.url}`);
      printDealIssues(r);
    }
  }
  console.log('');
}

module.exports = {
  writeReport,
  openReport,
  printSummary,
  printDealIssues,
  formatComment,
};
