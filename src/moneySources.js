/**
 * Чистые разборы сумм: Нал/QR, списание, СДЭК, эквайринг.
 * Без Playwright — удобно тестировать.
 */
const config = require('../config');
const { normalize, parseMoney, isPlausibleMoney, MONEY_TOKEN } = require('./utils');

function shouldSkipClientInvoice(dealName) {
  const name = normalize(dealName).replace(/^\s+/, '');
  return (config.skipClientInvoiceNamePrefixes || [])
    .map((p) => normalize(p))
    .some((p) => p && name.startsWith(p));
}

/** «Нал-Ю26-2900» / «QR-Ю26-97200» → хвостовая сумма сделки. */
function parseDealAmountFromTitle(dealName) {
  const raw = String(dealName || '').trim();
  if (!raw || !shouldSkipClientInvoice(raw)) return null;
  const nums = raw.match(/\d+(?:[.,]\d+)?/g);
  if (!nums?.length) return null;
  let last = parseMoney(nums[nums.length - 1]);
  if (!isPlausibleMoney(last) || last < 100) return null;
  if (last >= 2000 && last <= 2100 && nums.length >= 2) {
    const prev = parseMoney(nums[nums.length - 2]);
    if (isPlausibleMoney(prev) && prev >= 100) last = prev;
  }
  return last >= 100 ? last : null;
}

function acquiringFeeVariants(dealAmount, pct = 3) {
  const raw = dealAmount * (pct / 100);
  return [Math.round(raw * 100) / 100, Math.round(raw), Math.floor(raw * 100) / 100, Math.ceil(raw * 100) / 100];
}

function resolveCashDealAmount(dealAmount, dealName, title, preferAmounts = []) {
  const candidates = [];
  const push = (n) => {
    if (isPlausibleMoney(n) && n >= 100 && !candidates.some((c) => Math.abs(c - n) < 0.001)) {
      candidates.push(n);
    }
  };
  push(dealAmount);
  if (config.parseDealAmountFromTitle !== false) {
    push(parseDealAmountFromTitle(dealName));
    push(parseDealAmountFromTitle(title));
  }
  if (!candidates.length) return dealAmount;

  const pct = Number(config.acquiringFeePercent) || 3;
  const tol = Math.max(Number(config.amountTolerance) || 0, 1);
  const prefers = (preferAmounts || []).filter(Number.isFinite);
  for (const base of candidates) {
    for (const v of acquiringFeeVariants(base, pct)) {
      if (prefers.some((p) => Math.abs(p - v) <= tol)) return base;
    }
  }
  return parseDealAmountFromTitle(dealName) || parseDealAmountFromTitle(title) || candidates[0];
}

function amountAppearsInText(text, amount, tol = 1) {
  const re = new RegExp(MONEY_TOKEN, 'g');
  let m;
  while ((m = re.exec(String(text || '').replace(/\u00A0/g, ' '))) !== null) {
    const v = parseMoney(m[1]);
    if (v !== null && Math.abs(v - amount) <= tol) return true;
  }
  return false;
}

function amountAppearsNearSumLabel(text, amount, tol = 1) {
  for (const line of String(text || '').replace(/\u00A0/g, ' ').split(/\r?\n|;/)) {
    const low = line.toLowerCase().replace(/ё/g, 'е');
    if (!/(сумма|всего|на\s+сумму|(?:^|[^а-яa-z])итого(?:[^а-яa-z]|$))/i.test(low)) continue;
    if (/итого\s+(?:цена|стоимость)/i.test(low) && !/(сумма|всего|на\s+сумму)/i.test(low)) continue;
    if (/(цена|стоимость)/i.test(low) && !/(сумма|всего|на\s+сумму|(?:^|[^а-яa-z])итого(?:[^а-яa-z]|$))/i.test(low)) {
      continue;
    }
    if (amountAppearsInText(line, amount, tol)) return true;
  }
  return false;
}

/** В описании 1 позиция: «кол-во 1» / «1 шт» — цена = сумма списания. */
function textHasUnitQtyOne(text) {
  const s = String(text || '').replace(/\u00A0/g, ' ');
  return (
    /(?:кол-?во|количество|qty|quantity)\s*[:\-–=]?\s*1(?:\D|$)/i.test(s) ||
    /(?:^|[^\d])1\s*(?:шт\.?|штук[аи]?|единиц[аы]?)\b/i.test(s)
  );
}

function amountAppearsNearPriceLabel(text, amount, tol = 1) {
  const lines = String(text || '').replace(/\u00A0/g, ' ').split(/\r?\n|;/);
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase().replace(/ё/g, 'е');
    if (!/(?:^|[^а-яa-z])(?:цена|стоимость)(?:[^а-яa-z]|$)/i.test(low)) continue;
    if (amountAppearsInText(lines[i], amount, tol)) return true;
    // «Цена:» на одной строке, «3 000» на следующей
    if (i + 1 < lines.length && amountAppearsInText(lines[i + 1], amount, tol)) return true;
  }
  return false;
}

/**
 * Списание: «сумма» / «всего» / «на сумму» / «итого»;
 * «цена»/«стоимость» — если 1 шт или сумма совпала с графой затрат.
 */
function extractWriteOffAmountFromText(text, preferAmounts = []) {
  const raw = String(text || '').replace(/\u00A0/g, ' ');
  if (!raw.trim()) return null;

  const moneyTok = config.warehouseMoneyToken || MONEY_TOKEN;
  const B = '(?:^|[^0-9A-Za-zА-Яа-яЁё])';
  const E = '(?=[^0-9A-Za-zА-Яа-яЁё]|$)';
  const qtyOne = textHasUnitQtyOne(raw);
  const patterns = [
    new RegExp(
      `${B}всего${E}\\s*(?:к\\s*(?:оплате|списанию)|по\\s*списанию|списан[оа]?)?\\s*[:\\-=]?\\s*${moneyTok}`,
      'gi'
    ),
    new RegExp(
      `${B}сумма${E}\\s*(?:списания|итого|общая|к\\s*списанию)?\\s*[:\\-=]?\\s*${moneyTok}`,
      'gi'
    ),
    new RegExp(`${B}на\\s+сумму\\s*[:\\-=]?\\s*${moneyTok}`, 'gi'),
    // не «Итого цена 50» — это цена, не итог
    new RegExp(`${B}итого(?!\\s*(?:цена|стоимость))${E}\\s*[:\\-=]?\\s*${moneyTok}`, 'gi'),
    new RegExp(
      `(?:^|[\\n\\r;|/])\\s*(?:сумма|всего|итого(?!\\s*(?:цена|стоимость)))\\s*[:\\-=]?\\s*${moneyTok}`,
      'gi'
    ),
  ];
  // при 1 шт цена/стоимость = итог списания
  if (qtyOne) {
    patterns.push(
      new RegExp(`${B}(?:цена|стоимость)${E}\\s*[:\\-=]?\\s*${moneyTok}`, 'gi')
    );
  }

  const candidates = [];
  const priceCandidates = [];
  const seen = new Set();
  const pushInto = (list, v) => {
    if (!isPlausibleMoney(v)) return;
    const key = String(Math.round(v * 100) / 100);
    if (seen.has(key) && list === candidates) return;
    if (list === candidates) seen.add(key);
    if (!list.some((x) => Math.abs(x - v) < 0.001)) list.push(v);
  };
  const push = (v) => pushInto(candidates, v);

  const isPriceOnlyContext = (around) => {
    const low = String(around || '').toLowerCase().replace(/ё/g, 'е');
    const hasPrice = new RegExp(`${B}(?:цена|стоимость)${E}`, 'i').test(low);
    const hasSum =
      new RegExp(`${B}сумма${E}`, 'i').test(low) ||
      new RegExp(`${B}всего${E}`, 'i').test(low) ||
      new RegExp(`${B}итого${E}`, 'i').test(low) ||
      /на\s+сумму/i.test(low);
    return hasPrice && !hasSum;
  };

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const slice = raw.slice(Math.max(0, m.index - 16), Math.min(raw.length, m.index + m[0].length + 8));
      if (!qtyOne && isPriceOnlyContext(slice)) continue;
      push(parseMoney(m[1]));
    }
  }

  // отдельные «цена/стоимость …» — для сверки с графой даже без «1 шт» в том же абзаце
  {
    const priceRe = new RegExp(`${B}(?:цена|стоимость)${E}\\s*[:\\-=]?\\s*${moneyTok}`, 'gi');
    let m;
    while ((m = priceRe.exec(raw)) !== null) {
      pushInto(priceCandidates, parseMoney(m[1]));
    }
    for (const line of raw.split(/\r?\n|;|\u2028|\u2029/)) {
      const low = line.toLowerCase().replace(/ё/g, 'е');
      if (!/(?:цена|стоимость)/i.test(low)) continue;
      const re = new RegExp(`(?:цена|стоимость)[^0-9]{0,24}${moneyTok}`, 'gi');
      while ((m = re.exec(line)) !== null) pushInto(priceCandidates, parseMoney(m[1]));
    }
  }

  for (const line of raw.split(/\r?\n|;|\u2028|\u2029/)) {
    const low = line.toLowerCase().replace(/ё/g, 'е');
    if (!new RegExp(`${B}(?:сумма|всего|итого)${E}|на\\s+сумму`, 'i').test(low)) continue;
    if (!qtyOne && isPriceOnlyContext(low)) continue;
    if (/итого\s+(?:цена|стоимость)/i.test(low) && !/(сумма|всего)/i.test(low)) continue;
    const re = new RegExp(
      `(?:сумма|всего|на\\s+сумму|итого(?!\\s*(?:цена|стоимость)))[^0-9]{0,24}${moneyTok}`,
      'gi'
    );
    let m;
    while ((m = re.exec(line)) !== null) {
      if (/цена|стоимость/i.test(m[0]) && !/(сумма|всего)/i.test(m[0])) continue;
      push(parseMoney(m[1]));
    }
  }

  const tol = Math.max(Number(config.amountTolerance) || 0, 1);
  const prefers = (preferAmounts || []).filter(Number.isFinite);
  const maxOf = (arr) => arr.reduce((a, b) => (a > b ? a : b), arr[0]);
  const matchPrefer = (list) => {
    let best = null;
    let bestDist = Infinity;
    for (const c of list) {
      for (const p of prefers) {
        const d = Math.abs(c - p);
        if (d > tol) continue;
        if (best === null || d < bestDist || (d === bestDist && p > best)) {
          best = p;
          bestDist = d;
        }
      }
    }
    return best;
  };

  if (prefers.length) {
    const fromSum = matchPrefer(candidates);
    if (fromSum !== null) return fromSum;

    const nearSum = prefers.filter((p) => amountAppearsNearSumLabel(raw, p, tol));
    if (nearSum.length) return maxOf(nearSum);

    // графа = цена/стоимость в описании (часто 1 товар без слова «сумма»)
    const fromPrice = matchPrefer(priceCandidates);
    if (fromPrice !== null) return fromPrice;
    const nearPrice = prefers.filter((p) => amountAppearsNearPriceLabel(raw, p, tol));
    if (nearPrice.length) return maxOf(nearPrice);

    // описание задачи без ярлыков: крупная графа явно есть в тексте
    const inText = prefers.filter((p) => amountAppearsInText(raw, p, tol));
    if (inText.length) {
      const maxP = Math.max(...prefers);
      const big = inText.filter((p) => p >= maxP * 0.5);
      if (big.length) return Math.max(...big);
    }
  }

  if (!candidates.length) {
    if (qtyOne && priceCandidates.length) return maxOf(priceCandidates);
    return null;
  }

  if (prefers.length) {
    const maxPrefer = Math.max(...prefers);
    const plausible = candidates.filter(
      (c) => c <= maxPrefer * 1.25 || prefers.some((p) => Math.abs(c - p) <= Math.max(tol, p * 0.15))
    );
    return plausible.length ? maxOf(plausible) : null;
  }
  return maxOf(candidates);
}

function extractCdekAmountsFromComments(comments) {
  const hints = (config.cdekCommentHints || []).map((h) => normalize(h));
  const moneyToken = MONEY_TOKEN;
  const nearCdek = new RegExp(
    `(?:сдэк|cdek|сдек)[^0-9]{0,40}${moneyToken}|${moneyToken}[^0-9]{0,20}(?:сдэк|cdek|сдек)`,
    'gi'
  );
  const out = [];
  const seen = new Set();
  const minCdek = Number(config.minSourceAmount) || 50;

  const push = (v, raw) => {
    if (!isPlausibleMoney(v) || v < minCdek) return;
    const key = String(v);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ amount: v, snippet: String(raw).slice(0, 120) });
  };

  for (const raw of comments || []) {
    const low = normalize(raw);
    if (!hints.some((h) => low.includes(h))) continue;

    let m;
    nearCdek.lastIndex = 0;
    let foundNear = false;
    while ((m = nearCdek.exec(raw)) !== null) {
      foundNear = true;
      push(parseMoney(m[1] || m[2]), raw);
    }
    if (!foundNear && String(raw).length < 220) {
      const moneyRe = new RegExp(moneyToken, 'g');
      while ((m = moneyRe.exec(raw)) !== null) push(parseMoney(m[1]), raw);
    }
  }
  return out;
}

function acquiringCommentHit(comments) {
  const regexes = [...(config.acquiringCommentRegexes || [])].filter(Boolean);
  for (const raw of comments || []) {
    const text = String(raw || '');
    if (!text) continue;
    if (regexes.some((re) => re.test(text))) return text.slice(0, 160);
    const low = normalize(text);
    if (
      /3\s*%/.test(low) &&
      (low.includes('эквайр') || low.includes('терминал') || low.includes('картой') || low.includes('безнал'))
    ) {
      return text.slice(0, 160);
    }
  }
  return '';
}

function extractAcquiringFeesFromComments(comments, dealAmount, preferAmounts = [], opts = {}) {
  const pct = Number(config.acquiringFeePercent) || 3;
  const tol = Math.max(Number(config.amountTolerance) || 0, 1);
  const prefers = (preferAmounts || []).filter(Number.isFinite);
  const matchedSnippet = acquiringCommentHit(comments);

  const bases = [];
  const pushBase = (b) => {
    if (isPlausibleMoney(b) && b >= 100 && !bases.some((x) => Math.abs(x - b) < 0.001)) bases.push(b);
  };
  pushBase(dealAmount);
  if (config.parseDealAmountFromTitle !== false) {
    pushBase(parseDealAmountFromTitle(opts.dealName));
    pushBase(parseDealAmountFromTitle(opts.title));
  }
  if (!bases.length) return [];

  let best = null;
  for (const base of bases) {
    for (const v of acquiringFeeVariants(base, pct)) {
      for (const p of prefers) {
        const d = Math.abs(v - p);
        if (d <= tol && (!best || d < best.dist)) best = { fieldHit: p, base, dist: d };
      }
    }
  }

  // графа ≈ 3% от базы сделки — надёжный сигнал для Нал/QR (даже при кривом комментарии)
  if (best && config.acquiringMatchFromCostFields !== false) {
    return [
      {
        amount: best.fieldHit,
        base: best.base,
        snapped: true,
        fromField: true,
        snippet: matchedSnippet || `3% от ${best.base} = ${best.fieldHit} (из графы)`,
      },
    ];
  }

  if (!matchedSnippet) return [];
  const fee = acquiringFeeVariants(bases[0], pct)[0];
  if (!isPlausibleMoney(fee)) return [];
  return [{ amount: fee, base: bases[0], snapped: false, fromField: false, snippet: matchedSnippet }];
}

function extractLabeledAmount(text) {
  const re = new RegExp(
    `(?:итого|всего\\s+к\\s+оплате|сумма(?:\\s*с\\s*ндс)?|к\\s+оплате)\\s*[:\\-]?\\s*${MONEY_TOKEN}`,
    'i'
  );
  const m = String(text || '').match(re);
  if (!m) return null;
  const v = parseMoney(m[1]);
  return isPlausibleMoney(v) ? v : null;
}

module.exports = {
  shouldSkipClientInvoice,
  parseDealAmountFromTitle,
  resolveCashDealAmount,
  extractWriteOffAmountFromText,
  extractCdekAmountsFromComments,
  extractAcquiringFeesFromComments,
  extractLabeledAmount,
  acquiringFeeVariants,
};
