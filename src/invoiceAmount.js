const fs = require('fs');
const path = require('path');
const config = require('../config');
const { parseMoney, normalize, isPlausibleMoney, amountsEqual, MONEY_TOKEN } = require('./utils');

/**
 * Сумма из файла счёта поставщика: Excel / PDF / Word / текст.
 * opts.preferAmounts — суммы из граф затрат: учитываем ТОЛЬКО если они стоят
 * у ярлыка итого/сумма/к оплате. Случайное число из середины PDF не подставляем —
 * иначе сделка «зеленеет», хотя итог счёта другой.
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
  const wb = XLSX.readFile(filePath, { cellDates: true, cellText: true });
  const amounts = [];
  const labeled = [];
  const strongLabeled = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const rowsRaw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    for (let r = 0; r < rowsRaw.length; r++) {
      for (const cell of rowsRaw[r] || []) {
        if (typeof cell === 'number' && isPlausibleMoney(cell)) amounts.push(cell);
      }
    }

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const rawRow = rowsRaw[r] || [];
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? '');
        for (const m of findAllMoney(cell)) amounts.push(m);
        const money = parseMoney(cell);
        if (isPlausibleMoney(money)) amounts.push(money);

        const label = normalize(cell);
        if (isVatOnlyLabel(label) || isNetWithoutVatLabel(label) || !isTotalLabel(label)) continue;
        const strong = isStrongTotalLabel(label);
        const bucket = strong ? strongLabeled : labeled;
        // «Сумма» в шапке таблицы — не итог; иначе подтягиваем строки товаров
        if (!strong && isBareColumnHeader(label)) continue;

        const before = bucket.length;
        const pushMoney = (m) => {
          if (isPlausibleMoney(m) && !looksLikeVatOnlyAmount(m, preferAmounts)) bucket.push(m);
        };

        // та же ячейка («на сумму 70 455,00 руб»)
        for (const m of findAllMoney(cell)) pushMoney(m);

        // справа: для «Итого:» — вся строка (1С часто ставит сумму далеко справа)
        const rightLimit = strong ? row.length : Math.min(row.length, c + 6);
        for (let k = c + 1; k < rightLimit; k++) {
          pushMoney(parseMoney(row[k]));
          if (typeof rawRow[k] === 'number') pushMoney(rawRow[k]);
        }

        // ниже — только если в строке ярлыка суммы нет (иначе шапка «Сумма»/пустой «Итого» тянет товары)
        if (bucket.length === before) {
          if (rows[r + 1]) {
            for (let k = Math.max(0, c - 1); k < Math.min(rows[r + 1].length, c + 6); k++) {
              pushMoney(parseMoney(rows[r + 1][k]));
              const nr = rowsRaw[r + 1];
              if (nr && typeof nr[k] === 'number') pushMoney(nr[k]);
            }
          }
          for (let dr = 1; dr <= 3; dr++) {
            if (!rows[r + dr]) break;
            pushMoney(parseMoney(rows[r + dr][c]));
            if (c + 1 < (rows[r + dr] || []).length) pushMoney(parseMoney(rows[r + dr][c + 1]));
          }
        }
      }
    }
  }

  const picked = pickBestAmount(labeled, amounts, strongLabeled, preferAmounts);
  return refineWithPreferInAmounts(picked, amounts, preferAmounts, strongLabeled);
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

  const text = data?.text || data?.content || String(data || '');
  const picked = extractAmountFromText(text, preferAmounts);
  // если явный итог найден — не трогаем; иначе ищем графу в тексте/сыром PDF (OCR)
  if (picked !== null) return picked;
  const rawBuf = buffer.toString('latin1');
  return findPreferInRawText(`${text}\n${rawBuf}`, preferAmounts);
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
  const payStrong = []; // «к оплате» / прописью — выше голого «Итого» (нетто)
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const low = normalize(line);
    const moneyInLine = findAllMoney(line);
    amounts.push(...moneyInLine);

    const wordsPay = extractPayAmountInWords(line);
    if (wordsPay != null) {
      amounts.push(wordsPay);
      if (!looksLikeVatOnlyAmount(wordsPay, preferAmounts)) payStrong.push(wordsPay);
    }

    if (isVatOnlyLabel(low) || isNetWithoutVatLabel(low)) continue;
    if (isStrongTotalLabel(low)) {
      const vals = moneyInLine.filter((n) => !looksLikeVatOnlyAmount(n, preferAmounts));
      // смешанная строка «к оплате … прописью, Итого 24065»: цифры = нетто → обычный итог
      if (isPayTotalLabel(low) && wordsPay == null) payStrong.push(...vals);
      else strongLabeled.push(...vals);
      if (!moneyInLine.length && !wordsPay && lines[i + 1]) {
        const next = findAllMoney(lines[i + 1]).filter(
          (n) => !looksLikeVatOnlyAmount(n, preferAmounts)
        );
        if (isPayTotalLabel(low)) payStrong.push(...next);
        else strongLabeled.push(...next);
      }
    } else if (isTotalLabel(low)) {
      if (isBareColumnHeader(low)) continue;
      const vals = moneyInLine.filter((n) => !looksLikeVatOnlyAmount(n, preferAmounts));
      labeled.push(...vals);
      if (!moneyInLine.length && lines[i + 1]) {
        labeled.push(
          ...findAllMoney(lines[i + 1]).filter((n) => !looksLikeVatOnlyAmount(n, preferAmounts))
        );
      }
    }
  }

  const strongRe = new RegExp(
    `(?:итого(?:\\s+к\\s+оплате)?|всего\\s+к\\s+оплате|сумма\\s+к\\s+оплате|всего\\s*[:\\-]|сумма\\s*с\\s*ндс)\\s*[:\\-]?\\s*${MONEY_TOKEN}`,
    'gi'
  );
  const weakRe = new RegExp(
    `(?:сумма(?!\\s*ндс)(?!\\s*налог)(?!\\s*vat)(?!\\s*без))\\s*[:\\-]?\\s*${MONEY_TOKEN}`,
    'gi'
  );
  let m;
  while ((m = strongRe.exec(text)) !== null) {
    const val = parseMoney(m[1]);
    if (isPlausibleMoney(val) && !looksLikeVatOnlyAmount(val, preferAmounts)) {
      const chunk = normalize(m[0]);
      if (isPayTotalLabel(chunk)) payStrong.push(val);
      else strongLabeled.push(val);
    }
  }
  while ((m = weakRe.exec(text)) !== null) {
    const val = parseMoney(m[1]);
    if (isPlausibleMoney(val) && !looksLikeVatOnlyAmount(val, preferAmounts)) {
      labeled.push(val);
    }
  }

  if (payStrong.length) {
    const payPick = pickBestAmount(labeled, amounts, payStrong, preferAmounts);
    const refinedPay = refineWithPreferInAmounts(payPick, amounts, preferAmounts, payStrong);
    if (refinedPay != null && preferMatches(refinedPay, preferAmounts)) return refinedPay;
    const plainPick = pickBestAmount(labeled, amounts, strongLabeled, preferAmounts);
    const refinedPlain = refineWithPreferInAmounts(plainPick, amounts, preferAmounts, strongLabeled);
    if (refinedPlain != null && preferMatches(refinedPlain, preferAmounts)) return refinedPlain;
    if (refinedPay != null) return refinedPay;
    return refinedPlain;
  }

  const picked = pickBestAmount(labeled, amounts, strongLabeled, preferAmounts);
  return refineWithPreferInAmounts(picked, amounts, preferAmounts, strongLabeled);
}

function preferMatches(amount, preferAmounts = []) {
  const tol = Math.max(Number(config.amountTolerance) || 1, 0.05);
  return (preferAmounts || []).some((p) => isPlausibleMoney(p) && amountsEqual(amount, p, tol));
}

/**
 * Уточнение по графам:
 * - явный «Итого» никогда не понижаем до другой графы (5480 ≠ 4900);
 * - если итог не помечен / это «без НДС» — можно взять графу из чисел файла или НДС×ставку.
 */
function refineWithPreferInAmounts(picked, amounts, preferAmounts = [], strongLabeled = []) {
  const prefs = [...(preferAmounts || [])]
    .filter((n) => isPlausibleMoney(n))
    .sort((a, b) => b - a);
  if (!prefs.length) return picked;
  const tol = Math.max(Number(config.amountTolerance) || 1, 0.05);
  const pool = dedupeAmounts(amounts || []).filter(
    (n) => isPlausibleMoney(n) && withinPreferScale(n, prefs)
  );
  const maxAmt = pool.length ? Math.max(...pool) : 0;
  const hasStrong = (strongLabeled || []).some((n) => isPlausibleMoney(n));

  if (picked !== null && preferMatches(picked, prefs)) return picked;

  // сильный итог документа — священный, даже если не совпал с графой
  if (
    hasStrong &&
    picked !== null &&
    (strongLabeled || []).some((s) => amountsEqual(s, picked, tol))
  ) {
    return picked;
  }
  if (picked !== null && maxAmt > 0 && amountsEqual(picked, maxAmt, tol) && hasStrong) {
    return picked;
  }

  // графа есть среди чисел файла и ≈ максимуму документа
  const hits = prefs.filter((p) => pool.some((a) => amountsEqual(a, p, tol)));
  if (hits.length && maxAmt > 0) {
    hits.sort((a, b) => Math.abs(a - maxAmt) - Math.abs(b - maxAmt));
    if (hits[0] >= maxAmt * 0.95) {
      if (picked === null) return hits[0];
      // не понижаем крупный итог до меньшей графы
      if (hits[0] + tol >= picked) return hits[0];
    }
  }

  // нетто → графа по ставке НДС / близкому брутто (только без сильного «Итого»)
  const baseAmt = picked !== null ? picked : pool.length ? Math.max(...pool) : null;
  if (baseAmt !== null && !hasStrong) {
    for (const prefer of prefs) {
      for (const rate of [1.22, 1.2, 1.18, 1.1]) {
        if (Math.abs(baseAmt * rate - prefer) <= Math.max(tol, prefer * 0.002)) return prefer;
      }
      // близкий промах нетто→брутто (24065→27014 ≈ +12.2%)
      if (prefer > baseAmt && (prefer - baseAmt) / prefer <= 0.13 && prefer <= baseAmt * 1.25) {
        return prefer;
      }
    }
  }

  return picked;
}

/**
 * Ищем сумму графы в сыром тексте (в т.ч. «27 014» / «27014,00» / склейка в PDF-потоке).
 * Крупнейшую графу — первой.
 */
function findPreferInRawText(text, preferAmounts = []) {
  const prefs = [...(preferAmounts || [])]
    .filter((n) => isPlausibleMoney(n))
    .sort((a, b) => b - a);
  if (!prefs.length) return null;
  const tol = Math.max(Number(config.amountTolerance) || 1, 0.05);
  const raw = String(text || '');
  const moneys = findAllMoney(raw.replace(/\u00A0/g, ' '));

  const hits = [];
  for (const prefer of prefs) {
    let ok = moneys.some((a) => amountsEqual(a, prefer, tol));
    if (!ok) {
      // только явное число с границами — без digits.includes (склейка PDF → ложные 4900)
      const intPart = String(Math.trunc(Math.abs(prefer)));
      if (intPart.length >= 3) {
        const spaced = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s\\u00A0]*');
        const reSpaced = new RegExp(`(?:^|[^\\d])${spaced}(?:[.,]\\d{1,2})?(?:[^\\d]|$)`);
        if (reSpaced.test(raw.replace(/\u00A0/g, ' '))) ok = true;
      }
    }
    if (ok) hits.push(prefer);
  }
  if (!hits.length) return null;
  const scaledMoneys = moneys.filter((n) => withinPreferScale(n, prefs));
  const moneyMax = scaledMoneys.length ? Math.max(...scaledMoneys) : 0;
  const hitMax = Math.max(...hits);
  // если в сыром тексте есть графа заметно больше «распознанного» итога — это и есть итог
  // (типично: в PDF видна строка 18130, а итого 93000 только в конце потока)
  if (moneyMax > 0 && hitMax >= moneyMax * 1.2) return hitMax;
  const docMax = moneyMax || hitMax;
  hits.sort((a, b) => Math.abs(a - docMax) - Math.abs(b - docMax));
  return hits[0];
}

function findAllMoney(line) {
  const out = [];
  const s = String(line || '');
  const re = new RegExp(MONEY_TOKEN, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1];
    if (/^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$/.test(raw)) continue;

    // не резать ИНН/р.с. «9731107362» на «9731107» + «362»
    const idx = m.index;
    const before = idx > 0 ? s[idx - 1] : '';
    const after = s[idx + m[0].length] || '';
    if (/\d/.test(before) || /\d/.test(after)) continue;

    // «100 200 300» — три суммы, не число 100200300 с тысячными пробелами
    const spaced = raw.replace(/\u00A0/g, ' ');
    if (!/[.,]\d/.test(spaced) && /^\d{3}(?: \d{3}){2,}$/.test(spaced)) {
      for (const part of spaced.split(/\s+/)) {
        const val = parseMoney(part);
        if (isPlausibleMoney(val)) out.push(val);
      }
      continue;
    }

    const val = parseMoney(raw);
    if (isPlausibleMoney(val)) out.push(val);
  }
  return out;
}

/** Шапка колонки таблицы («Сумма», «Цена») — не денежный итог. */
function isBareColumnHeader(label) {
  const s = normalize(label);
  if (!s || /\d/.test(s)) return false;
  return /^(сумма|цена|стоимость|кол-во|количество|ндс|ставка|артикул)$/.test(s);
}

/** Ярлык именно суммы к перечислению (не голый «Итого» = часто нетто). */
function isPayTotalLabel(label) {
  const s = normalize(label);
  if (!s) return false;
  if (/действителен|в течение/.test(s)) return false;
  return (
    s.includes('всего к оплате') ||
    s.includes('итого к оплате') ||
    s.includes('сумма к оплате') ||
    /^к\s+оплате\s*[:\-]?/.test(s) ||
    s.includes('total due') ||
    s.includes('amount due')
  );
}

/**
 * «Всего к оплате сумма: двадцать семь тысяч четырнадцать рублей…»
 * Цифры в такой строке часто нетто («Итого 24 065»), пропись — к оплате.
 */
function extractPayAmountInWords(line) {
  const s = normalize(String(line || ''));
  if (!s || !isPayTotalLabel(s)) return null;
  const m = s.match(
    /(?:всего\s+к\s+оплате|сумма\s+к\s+оплате|итого\s+к\s+оплате|к\s+оплате)[^\n]{0,80}?сумма\s*:?\s*([а-яё\s\-]+?)\s*рубл/
  );
  if (!m) {
    const m2 = s.match(
      /(?:всего\s+к\s+оплате|сумма\s+к\s+оплате|итого\s+к\s+оплате)\s*:?\s*([а-яё\s\-]+?)\s*рубл/
    );
    if (!m2) return null;
    return parseRussianMoneyWords(m2[1]);
  }
  return parseRussianMoneyWords(m[1]);
}

function parseRussianMoneyWords(words) {
  const raw = normalize(String(words || ''))
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  const ones = {
    ноль: 0,
    один: 1,
    одна: 1,
    одно: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
  };
  const teens = {
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12,
    тринадцать: 13,
    четырнадцать: 14,
    пятнадцать: 15,
    шестнадцать: 16,
    семнадцать: 17,
    восемнадцать: 18,
    девятнадцать: 19,
  };
  const tens = {
    двадцать: 20,
    тридцать: 30,
    сорок: 40,
    пятьдесят: 50,
    шестьдесят: 60,
    семьдесят: 70,
    восемьдесят: 80,
    девяносто: 90,
  };
  const hundreds = {
    сто: 100,
    двести: 200,
    триста: 300,
    четыреста: 400,
    пятьсот: 500,
    шестьсот: 600,
    семьсот: 700,
    восемьсот: 800,
    девятьсот: 900,
  };

  let total = 0;
  let current = 0;
  let ok = false;
  for (const w of raw.split(' ')) {
    if (!w || w === 'рубль' || w === 'рубля' || w === 'рублей' || w === 'руб') continue;
    if (w === 'тысяча' || w === 'тысячи' || w === 'тысяч') {
      if (current === 0) current = 1;
      total += current * 1000;
      current = 0;
      ok = true;
      continue;
    }
    if (w === 'миллион' || w === 'миллиона' || w === 'миллионов') {
      if (current === 0) current = 1;
      total += current * 1000000;
      current = 0;
      ok = true;
      continue;
    }
    if (hundreds[w] != null) {
      current += hundreds[w];
      ok = true;
      continue;
    }
    if (teens[w] != null) {
      current += teens[w];
      ok = true;
      continue;
    }
    if (tens[w] != null) {
      current += tens[w];
      ok = true;
      continue;
    }
    if (ones[w] != null) {
      current += ones[w];
      ok = true;
      continue;
    }
    // неизвестное слово в середине — обрыв
    if (ok) break;
  }
  total += current;
  return ok && isPlausibleMoney(total) ? total : null;
}

/** «Сумма без НДС» — не итог к оплате. */
function isNetWithoutVatLabel(label) {
  const s = normalize(label);
  if (!s) return false;
  return (
    s.includes('без ндс') ||
    s.includes('без налога') ||
    s.includes('excluding vat') ||
    s.includes('net of vat') ||
    s.includes('netto')
  );
}

/** «Сумма НДС» / VAT — это не итог счёта. «Сумма с НДС» — наоборот, хороший итог. */
function isVatOnlyLabel(label) {
  const s = normalize(label);
  if (!s) return false;
  if (
    s.includes('сумма с ндс') ||
    s.includes('суммандс') ||
    s.includes('всего с ндс') ||
    s.includes('итого с ндс') ||
    s.includes('включая ндс') ||
    s.includes('без ндс') ||
    s.includes('total with vat')
  ) {
    return false;
  }
  if (
    s.includes('сумма ндс') ||
    s.includes('ндс сумма') ||
    s.includes('размер ндс') ||
    s.includes('в т.ч. ндс') ||
    s.includes('в том числе ндс') ||
    s.includes('vat amount') ||
    s.includes('tax amount')
  ) {
    return true;
  }
  if (s.includes('налог') && s.includes('сумма') && !s.includes('с налог')) return true;
  return false;
}

function isStrongTotalLabel(label) {
  const s = normalize(label);
  if (isVatOnlyLabel(s) || isNetWithoutVatLabel(s)) return false;
  // «всего наименований / позиций» — не денежный итог
  if (/всего\s+(наименован|позиц|товар)/.test(s)) return false;
  // не путать с «счет действителен к оплате в течение…»
  if (/действителен|в течение/.test(s)) return false;
  return (
    s.includes('итого') ||
    s.includes('всего к оплате') ||
    s.includes('итого к оплате') ||
    s.includes('сумма к оплате') ||
    /^к\s+оплате\s*[:\-]?/.test(s) ||
    s.includes('сумма с ндс') ||
    s.includes('суммандс') ||
    /^всего\s*[:\-]?$/.test(s) ||
    /^всего\s*[:\-]/.test(s) ||
    s.includes('total due') ||
    s.includes('grand total')
  );
}

function isTotalLabel(label) {
  const s = normalize(label);
  if (isVatOnlyLabel(s) || isNetWithoutVatLabel(s)) return false;
  if (isStrongTotalLabel(s)) return true;
  return (
    s.includes('total') ||
    (s.includes('сумма') &&
      !s.includes('количество') &&
      !s.includes('номер') &&
      !s.includes('счет') &&
      !s.includes('счёт'))
  );
}

/** Сумма ≈ 18%/20%/22% от более крупной — почти наверняка НДС. */
function looksLikeVatOnlyAmount(amount, preferAmounts = [], peers = []) {
  if (!isPlausibleMoney(amount)) return false;
  const tol = Math.max(Number(config.amountTolerance) || 1, 1);
  // сама графа / итог сделки — не НДС
  if ((preferAmounts || []).some((p) => isPlausibleMoney(p) && amountsEqual(amount, p, tol))) {
    return false;
  }
  const rates = [0.18, 0.2, 0.22, 18 / 118, 20 / 120, 22 / 122];
  // графы сделки + числа файла; сам match с графой уже отсечён выше
  const bases = [...(preferAmounts || []), ...(peers || [])].filter(
    (n) => isPlausibleMoney(n) && n > amount * 1.5
  );
  for (const prefer of bases) {
    for (const rate of rates) {
      const vat = prefer * rate;
      if (Math.abs(vat - amount) <= Math.max(tol, prefer * 0.002)) return true;
    }
    const ratio = amount / prefer;
    if (
      Math.abs(ratio - 0.18) < 0.01 ||
      Math.abs(ratio - 0.2) < 0.01 ||
      Math.abs(ratio - 0.22) < 0.01
    ) {
      return true;
    }
  }
  return false;
}

function dedupeAmounts(list) {
  const out = [];
  const seen = new Set();
  for (const n of list || []) {
    if (!isPlausibleMoney(n)) continue;
    const key = String(Math.round(n * 100) / 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Не брать р/с и прочий мусор, если рядом есть графы затрат. */
function withinPreferScale(n, preferAmounts = []) {
  const prefs = (preferAmounts || []).filter((x) => isPlausibleMoney(x));
  if (!prefs.length) return true;
  const maxP = Math.max(...prefs);
  // итог счёта не бывает в десятки раз больше любой графы этой сделки
  return n <= maxP * 2.5;
}

/**
 * Выбор итога счёта.
 * Приоритет: ярлык + графа → сильный итог → совпадение с графой в масштабе сделки.
 * «Самое большое число в файле» без ярлыка — больше не берём (ломало на р/с 502401001).
 */
function pickBestAmount(labeled, amounts, strongLabeled = [], preferAmounts = []) {
  const min = Number(config.minSourceAmount);
  const minAmt = Number.isFinite(min) ? min : 50;
  const tol = Number(config.amountTolerance);
  const matchTol = Number.isFinite(tol) ? Math.max(tol, 0.05) : 1;
  const prefs = (preferAmounts || []).filter((n) => isPlausibleMoney(n));

  const ok = (n, peers = []) =>
    isPlausibleMoney(n) &&
    n >= minAmt &&
    !looksLikeVatOnlyAmount(n, preferAmounts, peers) &&
    withinPreferScale(n, preferAmounts);

  const allRaw = dedupeAmounts([...(amounts || []), ...(labeled || []), ...(strongLabeled || [])]);
  const S = strongLabeled.filter((n) => ok(n, allRaw));
  const L = labeled.filter((n) => ok(n, allRaw));
  const pool = allRaw.filter((n) => ok(n, allRaw));
  const candidates = pool.length
    ? pool.filter((n) => !looksLikeVatOnlyAmount(n, preferAmounts, pool))
    : [];
  const use = candidates.length ? candidates : pool;
  const maxAmt = use.length ? Math.max(...use) : 0;

  // 1) сильный итог («Итого» / «к оплате») — важнее любой графы из середины PDF
  if (S.length) {
    if (prefs.length) {
      const preferStrong = prefs.filter((prefer) =>
        S.some((a) => amountsEqual(a, prefer, matchTol))
      );
      if (preferStrong.length) return Math.max(...preferStrong);
      const scaled = S.filter((n) => withinPreferScale(n, prefs));
      if (scaled.length) return Math.max(...scaled);
    }
    return Math.max(...S);
  }

  // 2) графа совпала со слабой меткой «сумма»
  if (prefs.length && L.length) {
    const preferLabeled = prefs.filter((prefer) =>
      L.some((a) => amountsEqual(a, prefer, matchTol))
    );
    if (preferLabeled.length) return Math.max(...preferLabeled);
  }

  // 3) графа есть среди чисел файла и ≈ максимуму документа (OCR / xls без ярлыка)
  if (prefs.length && use.length) {
    const preferHits = prefs.filter((prefer) =>
      use.some((a) => amountsEqual(a, prefer, matchTol))
    );
    if (preferHits.length) {
      const hitMax = Math.max(...preferHits);
      if (hitMax >= maxAmt * 1.2) return hitMax;
      preferHits.sort((a, b) => Math.abs(a - maxAmt) - Math.abs(b - maxAmt));
      if (preferHits[0] >= maxAmt * 0.95) return preferHits[0];
    }
  }

  // 4) слабая помеченная сумма в масштабе сделки
  if (L.length) {
    if (!prefs.length) return Math.max(...L);
    const scaledL = L.filter((n) => withinPreferScale(n, prefs));
    if (scaledL.length) return Math.max(...scaledL);
  }

  // 5) без граф: один доминирующий итог
  if (!prefs.length && candidates.length) {
    const sorted = [...candidates].sort((a, b) => b - a);
    if (sorted.length === 1) return sorted[0];
    if (sorted[0] >= sorted[1] * 2) return sorted[0];
  }

  return null;
}

module.exports = {
  extractAmountFromInvoiceFile,
  extractAmountFromText,
  pickBestAmount,
  isNetWithoutVatLabel,
};
