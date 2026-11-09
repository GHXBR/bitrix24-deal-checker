const fs = require('fs');
const path = require('path');
const { parseMoney, normalize, isPlausibleMoney, amountsEqual } = require('./utils');

/**
 * Сумма из файла счёта поставщика: Excel / PDF / Word / текст.
 * opts.preferAmounts — суммы из граф затрат: если такая есть в файле, берём её
 * (иначе часто цепляется строка товара вместо итога).
 */
async function extractAmountFromInvoiceFile(filePath, opts = {}) {
  const preferAmounts = opts.preferAmounts || [];
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') {
      return extractFromSpreadsheet(filePath, preferAmounts);
    }
    if (ext === '.pdf') return await extractFromPdf(filePath, preferAmounts);
    if (ext === '.docx') return await extractFromDocx(filePath, preferAmounts);
    return extractFromPlainBuffer(filePath, preferAmounts);
  } catch (err) {
    console.warn(`  не разобрал файл ${path.basename(filePath)}: ${err.message || err}`);
    return null;
  }
}

function extractFromSpreadsheet(filePath, preferAmounts = []) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const amounts = [];
  const labeled = [];
  const strongLabeled = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? '');
        const money = parseMoney(cell);
        if (isPlausibleMoney(money)) amounts.push(money);

        const label = normalize(cell);
        if (!isTotalLabel(label)) continue;
        const bucket = isStrongTotalLabel(label) ? strongLabeled : labeled;
        for (let k = c; k < Math.min(row.length, c + 4); k++) {
          const m = parseMoney(row[k]);
          if (isPlausibleMoney(m)) bucket.push(m);
        }
        if (rows[r + 1]) {
          for (const cell2 of rows[r + 1]) {
            const m = parseMoney(cell2);
            if (isPlausibleMoney(m)) bucket.push(m);
          }
        }
      }
    }
  }

  return pickBestAmount(labeled, amounts, strongLabeled, preferAmounts);
}

async function extractFromPdf(filePath, preferAmounts = []) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch {
    return null;
  }

  const buffer = fs.readFileSync(filePath);
  let data;
  if (typeof pdfParse === 'function') {
    data = await pdfParse(buffer);
  } else if (pdfParse?.PDFParse) {
    const parser = new pdfParse.PDFParse({ data: buffer });
    data = await parser.getText();
  } else if (pdfParse?.default) {
    data = await pdfParse.default(buffer);
  } else {
    return null;
  }

  return extractAmountFromText(data?.text || data?.content || String(data || ''), preferAmounts);
}

async function extractFromDocx(filePath, preferAmounts = []) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return extractAmountFromText(result.value || '', preferAmounts);
}

function extractFromPlainBuffer(filePath, preferAmounts = []) {
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7EА-Яа-яЁё₽]/g, ' ');
  return extractAmountFromText(text, preferAmounts);
}

function extractAmountFromText(text, preferAmounts = []) {
  const amounts = [];
  const labeled = [];
  const strongLabeled = [];
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const low = normalize(line);
    const moneyInLine = findAllMoney(line);
    amounts.push(...moneyInLine);
    if (isStrongTotalLabel(low)) {
      strongLabeled.push(...moneyInLine);
      if (lines[i + 1]) strongLabeled.push(...findAllMoney(lines[i + 1]));
    } else if (isTotalLabel(low)) {
      labeled.push(...moneyInLine);
      if (lines[i + 1]) labeled.push(...findAllMoney(lines[i + 1]));
    }
  }

  const strongRe =
    /(?:итого|всего\s+к\s+оплате|к\s+оплате|сумма\s*с\s*ндс)\s*[:\-]?\s*([0-9]{1,3}(?:[\s\u00A0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+[.,][0-9]{2}|[0-9]{2,7}(?:[.,][0-9]{1,2})?)/gi;
  const weakRe =
    /(?:сумма)\s*[:\-]?\s*([0-9]{1,3}(?:[\s\u00A0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+[.,][0-9]{2}|[0-9]{2,7}(?:[.,][0-9]{1,2})?)/gi;
  let m;
  while ((m = strongRe.exec(text)) !== null) {
    const val = parseMoney(m[1]);
    if (isPlausibleMoney(val)) strongLabeled.push(val);
  }
  while ((m = weakRe.exec(text)) !== null) {
    const val = parseMoney(m[1]);
    if (isPlausibleMoney(val)) labeled.push(val);
  }

  return pickBestAmount(labeled, amounts, strongLabeled, preferAmounts);
}

function findAllMoney(line) {
  const out = [];
  const re =
    /([0-9]{1,3}(?:[\s\u00A0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+[.,][0-9]{2}|[0-9]{2,7}(?:[.,][0-9]{1,2})?)/g;
  let m;
  while ((m = re.exec(String(line))) !== null) {
    const raw = m[1];
    if (/^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$/.test(raw)) continue;
    const val = parseMoney(raw);
    if (isPlausibleMoney(val)) out.push(val);
  }
  return out;
}

function isStrongTotalLabel(label) {
  return (
    label.includes('итого') ||
    label.includes('всего к оплате') ||
    label.includes('к оплате') ||
    label.includes('сумма с ндс') ||
    label.includes('суммандс') ||
    label.includes('total due') ||
    label.includes('grand total')
  );
}

function isTotalLabel(label) {
  if (isStrongTotalLabel(label)) return true;
  return (
    label.includes('total') ||
    (label.includes('сумма') &&
      !label.includes('количество') &&
      !label.includes('номер') &&
      !label.includes('счет') &&
      !label.includes('счёт'))
  );
}

function pickBestAmount(labeled, amounts, strongLabeled = [], preferAmounts = []) {
  const S = strongLabeled.filter(isPlausibleMoney);
  const L = labeled.filter(isPlausibleMoney);
  const A = amounts.filter(isPlausibleMoney);
  const pool = [...S, ...L, ...A];

  // Если в счёте есть сумма из графы затрат — это почти наверняка нужный итог
  for (const prefer of preferAmounts || []) {
    const hit = pool.find((a) => amountsEqual(a, prefer, 0.05));
    if (hit !== undefined) return hit;
  }

  if (S.length) return Math.max(...S);

  if (L.length) {
    const fromLabel = Math.max(...L);
    const fromAll = A.length ? Math.max(...A) : fromLabel;
    if (fromAll > fromLabel * 1.2) return fromAll;
    return fromLabel;
  }

  if (A.length) return Math.max(...A);
  return null;
}

module.exports = {
  extractAmountFromInvoiceFile,
  extractAmountFromText,
};
