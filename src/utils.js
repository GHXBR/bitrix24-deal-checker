const readline = require('readline');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Крутим условие, пока не станет true (или safety-timeout).
 * Выходим сразу, как только данные появились — не «спим N секунд».
 */
async function waitUntil(check, { timeoutMs = 15000, intervalMs = 150, label = '' } = {}) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return true;
    } catch (err) {
      lastErr = err;
      if (/closed|Target page|has been closed/i.test(String(err && err.message))) throw err;
    }
    await sleep(intervalMs);
  }
  if (label && lastErr) {
    // тихий таймаут — вызывающий решит
  }
  return false;
}

/**
 * Короткая «усадка» UI после клика: сначала minMs, потом ждём условие или maxMs.
 * На Windows длинные фиксированные sleep дают заметный лаг.
 */
async function settleAfterAction(check, { minMs = 200, maxMs = 3000, intervalMs = 100 } = {}) {
  if (minMs > 0) await sleep(minMs);
  if (typeof check !== 'function') return true;
  const left = Math.max(0, maxMs - minMs);
  if (left <= 0) return true;
  return waitUntil(check, { timeoutMs: left, intervalMs });
}

function normalize(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
}

function parseMoney(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim();
  if (!s) return null;

  s = s.replace(/₽/g, '').replace(/\bруб\.?\b/gi, '').trim();

  if (/^\d{1,3}([.\s]\d{3})+(,\d+)?$/.test(s.replace(/\u00A0/g, ' '))) {
    s = s.replace(/[\s\u00A0]/g, '').replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}([,\s]\d{3})+(\.\d+)?$/.test(s.replace(/\u00A0/g, ' '))) {
    s = s.replace(/[\s\u00A0]/g, '').replace(/,/g, '');
  } else {
    s = s.replace(/[\s\u00A0]/g, '').replace(',', '.');
  }

  s = s.replace(/[^\d.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

/** Отсекает р/с, ИНН и склейки цифр — не суммы счетов. */
function isPlausibleMoney(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return false;
  if (v < 1 || v >= 1e9) return false;
  if (String(Math.trunc(Math.abs(v))).length > 9) return false;
  if (v >= 2000 && v <= 2100 && Number.isInteger(v)) return false; // год
  return true;
}

/**
 * Чистит суммы-источники: мелочь из PDF и «сироты» без пары в графах.
 * entries: [{ amount, origin }]
 */
function sanitizeSourceEntries(entries, fieldAmounts, opts = {}) {
  const minAmount = Number(opts.minSourceAmount);
  const min = Number.isFinite(minAmount) ? minAmount : 50;
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : 1;
  const dropOrphans = opts.dropTinyOrphans !== false;
  const orphanMax = Number.isFinite(opts.orphanMaxAmount) ? opts.orphanMaxAmount : 200;
  const orphanRatio = Number.isFinite(opts.orphanMaxRatio) ? opts.orphanMaxRatio : 0.05;

  const fields = (fieldAmounts || []).filter((n) => Number.isFinite(n));
  const list = (entries || []).filter((e) => e && isPlausibleMoney(e.amount));
  const maxRef = Math.max(0, ...fields, ...list.map((e) => e.amount));

  const kept = [];
  const dropped = [];

  for (const entry of list) {
    const a = Number(entry.amount);
    const matchesField = fields.some((f) => Math.abs(f - a) <= tol);
    if (matchesField) {
      kept.push(entry);
      continue;
    }
    if (a < min) {
      dropped.push({ ...entry, reason: `ниже минимума ${min}` });
      continue;
    }
    if (dropOrphans && maxRef > 0 && a <= orphanMax && a < maxRef * orphanRatio) {
      dropped.push({ ...entry, reason: 'мелкая сирота без пары в графах' });
      continue;
    }
    kept.push(entry);
  }

  return { kept, dropped };
}

function formatSourceOrigins(entries) {
  return (entries || [])
    .map((e) => {
      const amount = Number.isFinite(e.amount) ? String(e.amount) : '';
      const origin = String(e.origin || '').trim();
      return origin ? `${amount} ← ${origin}` : amount;
    })
    .filter(Boolean)
    .join('; ');
}

function amountsEqual(a, b, tolerance = 0.05) {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= tolerance;
}

/** Сравнение наборов сумм как мультимножества (порядок не важен). */
function compareAmountSets(sourceAmounts, fieldAmounts, tolerance = 0.05) {
  const left = sourceAmounts
    .filter((n) => n !== null && Number.isFinite(n))
    .map((n) => Number(n))
    .filter((n) => Math.abs(n) >= 0.0001)
    .sort((a, b) => a - b);
  const right = fieldAmounts
    .filter((n) => n !== null && Number.isFinite(n))
    .map((n) => Number(n))
    .filter((n) => Math.abs(n) >= 0.0001)
    .sort((a, b) => a - b);

  const usedRight = new Array(right.length).fill(false);
  const missingInFields = [];

  for (const src of left) {
    let found = false;
    for (let i = 0; i < right.length; i++) {
      if (usedRight[i]) continue;
      if (amountsEqual(src, right[i], tolerance)) {
        usedRight[i] = true;
        found = true;
        break;
      }
    }
    if (!found) missingInFields.push(src);
  }

  const extraInFields = right.filter((_, i) => !usedRight[i]);
  const sumLeft = left.reduce((a, b) => a + b, 0);
  const sumRight = right.reduce((a, b) => a + b, 0);

  return {
    ok: missingInFields.length === 0 && extraInFields.length === 0,
    totalsMatch: amountsEqual(sumLeft, sumRight, Math.max(tolerance, 0.5)),
    sumSource: sumLeft,
    sumFields: sumRight,
    missingInFields,
    extraInFields,
    sourceSorted: left,
    fieldsSorted: right,
  };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

function waitForEnter(message) {
  return ask(message || 'Нажмите Enter, когда будете готовы продолжить...');
}

function formatMoney(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return String(n);
}

module.exports = {
  sleep,
  waitUntil,
  settleAfterAction,
  normalize,
  parseMoney,
  isPlausibleMoney,
  sanitizeSourceEntries,
  formatSourceOrigins,
  amountsEqual,
  compareAmountSets,
  ask,
  waitForEnter,
  formatMoney,
};
