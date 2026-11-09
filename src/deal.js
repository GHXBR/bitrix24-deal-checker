const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const { normalize, parseMoney, compareAmountSets, isPlausibleMoney, waitUntil } = require('./utils');
const { extractAmountFromInvoiceFile } = require('./invoiceAmount');
const { log, logStep, logOk, logWarn, logErr } = require('./log');
const { saveDebugDump, collectFrameTexts } = require('./debug');
const {
  openDealCard,
  closeDealPanel,
  resolveDealFrame,
  waitForDealFields,
  waitForCostAmounts,
  waitForTimelineReady,
  expandEditorSections,
  readFieldsFromFrame,
  readFieldByTextFallback,
  readCostFieldsFromFrame,
  findClientInvoiceInFrame,
  findPaymentTasksInFrame,
  readTimelineComments,
  scrollTimelineInFrame,
  dumpFrameDiagnostics,
} = require('./bitrixDealDom');

/**
 * Проверка одной сделки. В Битрикс ничего не пишет — только читает и сверяет.
 */

function addIssue(result, problem, fix) {
  if (result.issues.some((i) => i.problem === problem)) return;
  result.ok = false;
  result.issues.push({ problem, fix });
  result.errors.push(`${problem} → ${fix}`);
  log(`не так: ${problem}`);
  log(`исправить: ${fix}`);
}

/** НАЛ… / QR… — счёт заказчику не нужен. */
function shouldSkipClientInvoice(dealName) {
  const name = normalize(dealName).replace(/^\s+/, '');
  const prefixes = (config.skipClientInvoiceNamePrefixes || []).map((p) => normalize(p));
  return prefixes.some((p) => p && name.startsWith(p));
}

async function readDealCardData(dealFrame, deal) {
  await expandEditorSections(dealFrame);
  const fields = await readFieldsFromFrame(dealFrame);
  let dealName = fields[config.dealNameLabel] || '';
  let closeMonth = fields[config.closeMonthLabel] || '';
  let dealAmountText = fields[config.dealAmountLabel] || '';
  let costFields = await readCostFieldsFromFrame(dealFrame, config.costFieldLabels);

  if (!dealName) {
    dealName =
      (await readFieldByTextFallback(dealFrame, config.dealNameLabel)) || deal.title || '';
  }
  if (!closeMonth) {
    closeMonth = (await readFieldByTextFallback(dealFrame, config.closeMonthLabel)) || '';
  }
  if (!dealAmountText) {
    dealAmountText = (await readFieldByTextFallback(dealFrame, config.dealAmountLabel)) || '';
  }

  const dealAmount = parseMoney(dealAmountText);

  return { fields, dealName, closeMonth, dealAmount, dealAmountText, costFields };
}

async function checkDeal(page, deal, { previousDealId = '' } = {}) {
  const result = {
    id: deal.id,
    title: deal.title,
    url: deal.url,
    ok: true,
    errors: [],
    issues: [],
    details: {},
  };

  if (page.isClosed()) throw new Error('браузер закрыт');

  try {
  logStep('карточка', `открываю ${deal.url}`);
  let dealFrame = await openDealCard(page, deal.url, { previousDealId });
  result.details.frameUrl = dealFrame.url();

  logStep('поля', 'жду месяц...');
  await waitForDealFields(dealFrame, 20000);

  // дальше только после реальных сумм в графах затрат (не «не заполнено»)
  logStep('поля', 'жду суммы Поставщик / расходы...');
  let costsReady = await waitForCostAmounts(dealFrame, config.costFieldLabels, 30000);

  if (!costsReady) {
    // iframe мог пересоздаться — перехватываем и ждём ещё
    logWarn('суммы не появились — перечитываю iframe');
    const live = await resolveDealFrame(page, deal.url, 10000);
    if (live) dealFrame = live;
    costsReady = await waitForCostAmounts(dealFrame, config.costFieldLabels, 20000);
  }

  logStep('поля', 'читаю карточку...');
  let { dealName, closeMonth, dealAmount, costFields } = await readDealCardData(dealFrame, deal);

  if (!costFields.length) {
    // последний шанс: ещё раз expand + wait + read
    await expandEditorSections(dealFrame);
    costsReady = await waitForCostAmounts(dealFrame, config.costFieldLabels, 15000);
    const again = await readDealCardData(dealFrame, deal);
    dealName = again.dealName || dealName;
    closeMonth = again.closeMonth || closeMonth;
    dealAmount = again.dealAmount || dealAmount;
    costFields = again.costFields;
  }

  if (!costFields.length) {
    addIssue(
      result,
      'Не удалось прочитать суммы из граф затрат (Поставщик / доп.расходы / доставка) — блок не отрисовался',
      'Откройте сделку вручную, раскройте «Товары и маржинальность» и перезапустите проверку'
    );
    result.details.dealName = dealName;
    result.details.closeMonth = closeMonth;
    result.details.dealAmount = dealAmount;
    result.details.costFields = costFields;
    return result; // без сверки с пустыми графами — это ложные ошибки
  }

  logStep('таймлайн', 'жду ленту...');
  await waitForTimelineReady(dealFrame, 12000);
  await scrollTimelineInFrame(dealFrame, config.timelineScrollSteps || 4);

  const diag = await dumpFrameDiagnostics(dealFrame);
  log(
    `  iframe diag: len=${diag.len}, titles=${diag.titleCount}, stream=${diag.streamCount}, ` +
      `о_сделке=${diag.hasAbout}, месяц=${diag.hasMonth}, поставщик=${diag.hasSupplier}, ` +
      `счёт=${diag.hasInvoice}, предоплата=${diag.hasPrepay}`
  );

  log(`  название = «${dealName || '—'}»`);
  log(closeMonth ? `  месяц = «${closeMonth}»` : '  месяц пустой / не найден');
  log(
    dealAmount !== null && dealAmount !== undefined
      ? `  сумма сделки = ${dealAmount}`
      : '  сумма сделки не найдена'
  );
  if (!costFields.length) {
    logWarn('  заполненных граф затрат нет');
  } else {
    log('  графы затрат:');
    costFields.forEach((f) => log(`    ${f.label} = «${f.valueText}» → ${f.amount}`));
  }

  if (!diag.hasAbout || !diag.hasMonth) {
    const parts = await collectFrameTexts(page);
    saveDebugDump(
      deal.id,
      parts.map((p) => p.text).join('\n\n'),
      { dealUrl: deal.url, frameUrl: dealFrame.url(), ...diag },
      parts
    );
  }

  result.details.dealName = dealName;
  result.details.closeMonth = closeMonth;
  result.details.dealAmount = dealAmount;
  result.details.costFields = costFields;
  result.details.pageDiag = diag;

  if (!closeMonth) {
    addIssue(
      result,
      `Не заполнено поле «${config.closeMonthLabel}»`,
      `Откройте блок «О сделке» → заполните «${config.closeMonthLabel}» (например «2026 октябрь») и сохраните`
    );
  } else {
    logOk('проверка: месяц завершения заполнен');
  }

  // --- 1. Счёт заказчику ---
  const skipClientInvoice = shouldSkipClientInvoice(dealName || deal.title || '');
  if (skipClientInvoice) {
    logOk('проверка: счёт заказчику не требуется (НАЛ/QR)');
    result.details.clientInvoice = { found: false, skipped: true, fileName: '', snippet: '' };
  } else {
    logStep('счёт заказчику', 'ищу в ленте...');
    const clientInvoice = await findClientInvoiceInFrame(dealFrame, dealName);
    result.details.clientInvoice = clientInvoice;
    log(
      `  found=${clientInvoice.found}, file=«${clientInvoice.fileName || ''}», snippet=«${(clientInvoice.snippet || '').slice(0, 80)}»`
    );

    if (!clientInvoice.found) {
      addIssue(
        result,
        'Нет комментария «счёт заказчику» с вложенным файлом счёта',
        `В ленте сделки добавьте комментарий с текстом «счёт заказчику» и прикрепите файл исходящего счёта (в имени файла должен быть номер сделки${dealName ? ` «${dealName}»` : ''})`
      );
    } else if (
      clientInvoice.fileName &&
      dealName &&
      !normalize(clientInvoice.fileName).includes(normalize(dealName))
    ) {
      addIssue(
        result,
        `Номер в файле счёта заказчику не совпадает со сделкой: сделка «${dealName}», файл «${clientInvoice.fileName}»`,
        `Замените вложенный файл на счёт, в имени которого есть номер сделки «${dealName}»`
      );
    } else {
      logOk('проверка: счёт заказчику ок');
    }
  }

  // --- 2. Предоплата / Постоплата ---
  logStep('оплата поставщику', `ищу задачи: ${config.supplierPaymentTaskHints.join(', ')}`);
  const paymentTasks = await findPaymentTasksInFrame(
    dealFrame,
    config.supplierPaymentTaskHints,
    dealName
  );
  log(`  найдено задач оплаты: ${paymentTasks.length}`);
  paymentTasks.forEach((t, i) =>
    log(
      `  [${i + 1}] «${t.title}» файлов=${(t.files || []).length || (t.fileName ? 1 : 0)} «${(t.files || []).map((f) => f.fileName).join(' | ') || t.fileName || '—'}»`
    )
  );

  const preferAmounts = costFields.map((f) => f.amount).filter((n) => n !== null);
  const paymentAmounts = [];
  for (const task of paymentTasks) {
    logStep('оплата поставщику', `суммы из вложений «${task.title}»`);
    const amounts = await extractAllSupplierInvoiceAmounts(page, dealFrame, task, preferAmounts);
    if (!amounts.length) {
      addIssue(
        result,
        `В задаче «${task.title}» не удалось прочитать суммы из файлов счетов поставщика`,
        `Откройте задачу «${task.title}», проверьте вложения счетов (Excel/PDF/Word) с итоговой суммой; при необходимости замените файлы`
      );
    } else {
      amounts.forEach((item) => {
        log(`  файл «${item.fileName || '—'}» → ${item.amount}`);
        paymentAmounts.push({
          title: task.title,
          amount: item.amount,
          fileName: item.fileName || '',
        });
      });
    }
  }
  result.details.paymentTasks = paymentAmounts;

  // --- 3. Списание со склада ---
  logStep('списание', `ищу задачи «${config.warehouseTaskHint}»`);
  const writeOffTasks = await findPaymentTasksInFrame(
    dealFrame,
    [config.warehouseTaskHint],
    dealName
  );
  log(`  найдено задач списания: ${writeOffTasks.length}`);

  const writeOffAmounts = [];
  for (const task of writeOffTasks) {
    logStep('списание', `ищу «сумма/всего …» — «${task.title}»`);
    const amount = await extractWarehouseAmount(page, dealFrame, task);
    log(amount !== null ? `  сумма списания = ${amount}` : '  сумма/всего не найдены');
    writeOffAmounts.push({ title: task.title, amount });
    if (amount === null) {
      addIssue(
        result,
        `В задаче «${task.title}» нет суммы в формате «сумма …» или «всего …»`,
        `Откройте задачу «${task.title}» и укажите итог списания так: «сумма 297.99» или «всего 297.99» (не цену одной позиции)`
      );
    }
  }
  result.details.writeOffTasks = writeOffAmounts;

  // --- 3b. Комментарии: СДЭК + 3% эквайринг (НАЛ/QR) ---
  logStep('комментарии', 'читаю ленту (СДЭК / эквайринг)...');
  const comments = await readTimelineComments(dealFrame);
  const cdekAmounts = extractCdekAmountsFromComments(comments);
  const acquiringAmounts = shouldSkipClientInvoice(dealName || deal.title || '')
    ? extractAcquiringFeesFromComments(comments, dealAmount)
    : [];
  result.details.commentAmounts = { cdek: cdekAmounts, acquiring: acquiringAmounts };
  if (cdekAmounts.length) {
    log(`  СДЭК из комментариев: ${cdekAmounts.map((x) => x.amount).join(', ')}`);
  }
  if (acquiringAmounts.length) {
    log(
      `  эквайринг 3% от суммы сделки (${dealAmount}): ${acquiringAmounts.map((x) => x.amount).join(', ')}`
    );
  }

  // --- 4. Сверка сумм (порядок не важен) ---
  const sourceAmounts = [
    ...paymentAmounts.map((x) => x.amount),
    ...writeOffAmounts.map((x) => x.amount),
    ...cdekAmounts.map((x) => x.amount),
    ...acquiringAmounts.map((x) => x.amount),
  ].filter((n) => isPlausibleMoney(n));

  const fieldAmounts = costFields
    .map((f) => f.amount)
    .filter((n) => n !== null && Math.abs(n) >= 0.0001);

  result.details.sourceAmounts = sourceAmounts;
  result.details.fieldAmounts = fieldAmounts;

  logStep(
    'сверка',
    `задачи ${JSON.stringify([...sourceAmounts].sort((a, b) => a - b))} ↔ графы ${JSON.stringify(
      [...fieldAmounts].sort((a, b) => a - b)
    )}`
  );

  if (!sourceAmounts.length && !fieldAmounts.length) {
    logWarn('источников и граф затрат нет — сверку пропускаю');
  } else {
    const cmp = compareAmountSets(sourceAmounts, fieldAmounts, config.amountTolerance);
    result.details.amountCompare = cmp;
    log(
      `  ok=${cmp.ok}, totalsMatch=${cmp.totalsMatch} (Σ задач=${cmp.sumSource}, Σ граф=${cmp.sumFields})`
    );

    if (cmp.ok) {
      logOk('проверка: набор сумм совпадает');
    } else if (
      config.acceptMatchingTotals &&
      cmp.totalsMatch &&
      sourceAmounts.length &&
      fieldAmounts.length
    ) {
      logOk(`проверка: ИТОГО совпало (${cmp.sumSource}) — ок`);
      result.details.amountCompare.acceptedByTotal = true;
    } else if (sourceAmounts.length && !fieldAmounts.length) {
      addIssue(
        result,
        `В задачах есть суммы [${cmp.sourceSorted.join(', ')}], а графы затрат пустые (или не прочитались)`,
        `Проверьте блок «Товары и маржинальность»: суммы ${cmp.sourceSorted.join(', ')} должны быть в Поставщик / доп.расходы / доставка`
      );
    } else if (!sourceAmounts.length && fieldAmounts.length) {
      addIssue(
        result,
        `В графах затрат есть [${cmp.fieldsSorted.join(', ')}], но нет сумм из задач «Предоплата»/«Постоплата»/«Списание»`,
        `Добавьте задачи оплаты/списания на эти суммы — или очистите лишние графы`
      );
    } else {
      if (cmp.missingInFields.length) {
        addIssue(
          result,
          `Суммы из задач не найдены в графах затрат: ${cmp.missingInFields.join(', ')}. Задачи: [${cmp.sourceSorted.join(', ')}], графы: [${cmp.fieldsSorted.join(', ')}]`,
          `В «Товары и маржинальность» должна быть каждая из сумм ${cmp.missingInFields.join(', ')} (любая графа, любой порядок)`
        );
      }
      if (cmp.extraInFields.length) {
        addIssue(
          result,
          `В графах затрат есть суммы без задачи-источника: ${cmp.extraInFields.join(', ')}. Задачи: [${cmp.sourceSorted.join(', ')}], графы: [${cmp.fieldsSorted.join(', ')}]`,
          `Уберите лишние ${cmp.extraInFields.join(', ')} или добавьте задачи/счета с этими суммами`
        );
      }
    }
  }

  return result;
  } finally {
    // обязательно закрыть slider, иначе следующая сделка читается криво
    await closeDealPanel(page, deal.id).catch(() => {});
  }
}

/** Все счета из задачи оплаты → массив { amount, fileName }. */
async function extractAllSupplierInvoiceAmounts(page, dealFrame, task, preferAmounts = []) {
  const parseOpts = { preferAmounts };
  const results = [];
  const files =
    Array.isArray(task.files) && task.files.length
      ? task.files
      : task.fileHref || task.fileName
        ? [{ fileName: task.fileName || '', fileHref: task.fileHref || '' }]
        : [];

  if (!config.downloadSupplierInvoices) {
    logWarn('  скачивание счетов выключено (config.downloadSupplierInvoices)');
    const labeled = extractLabeledAmount(task.fingerprint || '', { strict: true });
    if (labeled !== null) results.push({ amount: labeled, fileName: '' });
    return results;
  }

  // 1) все вложения из карточки в ленте
  for (const file of files) {
    let amount = null;
    if (file.fileHref) {
      log(`  скачиваю «${file.fileName || file.fileHref.slice(0, 40)}»...`);
      amount = await downloadByHref(page, dealFrame, file.fileHref, file.fileName, parseOpts);
    }
    if (amount === null && file.fileName) {
      amount = await tryDownloadAndParseNearText(
        page,
        dealFrame,
        { ...task, fileName: file.fileName },
        parseOpts
      );
    }
    if (amount !== null) results.push({ amount, fileName: file.fileName || '' });
  }

  if (results.length) return results;

  // 2) открыть задачу и забрать все файлы из панели
  logWarn('  из ленты не вышло — открываю задачу, читаю все вложения');
  if (!(await openTask(page, dealFrame, task))) {
    logErr('  задачу открыть не удалось');
    return results;
  }

  const fromPanel = await tryDownloadAndParseAllInPanel(page, parseOpts);
  await closeSidePanel(page);
  return fromPanel;
}

async function downloadByHref(page, dealFrame, href, suggestedName, parseOpts = {}) {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-inv-'));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      dealFrame
        .evaluate((url) => {
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, href)
        .catch(async () => {
          await dealFrame.locator(`a[href="${href}"]`).first().click({ timeout: 3000 });
        }),
    ]);
    const filePath = path.join(tmpDir, download.suggestedFilename() || suggestedName || 'invoice.bin');
    await download.saveAs(filePath);
    logOk(`  скачан: ${filePath}`);
    return extractAmountFromInvoiceFile(filePath, parseOpts);
  } catch (err) {
    logWarn(`  downloadByHref: ${err.message || err}`);
    return null;
  }
}

async function tryDownloadAndParseNearText(page, dealFrame, task, parseOpts = {}) {
  const fileHint = task.fileName || 'Счет';
  try {
    const link = dealFrame.locator(`a:has-text("${fileHint}")`).first();
    if (!(await link.isVisible({ timeout: 800 }).catch(() => false))) return null;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-inv-'));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      link.click({ timeout: 3000 }),
    ]);
    const filePath = path.join(tmpDir, download.suggestedFilename());
    await download.saveAs(filePath);
    logOk(`  скачан: ${filePath}`);
    return extractAmountFromInvoiceFile(filePath, parseOpts);
  } catch (err) {
    logWarn(`  download/parse: ${err.message || err}`);
    return null;
  }
}

/** Скачать и разобрать все файлы-счета в открытой панели задачи. */
async function tryDownloadAndParseAllInPanel(page, parseOpts = {}) {
  const out = [];
  try {
    const filePattern = /\.(xls|xlsx|pdf|docx?|rtf|txt)$/i;
    const links = page.locator('a');
    const count = await links.count();
    const targets = [];
    const seen = new Set();

    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      const text = ((await link.textContent().catch(() => '')) || '').trim();
      const href = (await link.getAttribute('href').catch(() => '')) || '';
      const looksLikeFile =
        filePattern.test(text) ||
        /счет|счёт|проформа|invoice/i.test(text) ||
        href.includes('crm_show_file.php') ||
        href.includes('disk/uf.php');
      if (!looksLikeFile) continue;
      const key = href || text;
      if (!key || seen.has(key)) continue;
      if (!(await link.isVisible().catch(() => false))) continue;
      seen.add(key);
      targets.push({ link, text });
    }

    if (!targets.length) {
      logWarn('  файлы в панели не найдены');
      return out;
    }

    log(`  вложений в панели: ${targets.length}`);
    for (const { link, text } of targets) {
      try {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-inv-'));
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 20000 }),
          link.click({ timeout: 3000 }),
        ]);
        const filePath = path.join(tmpDir, download.suggestedFilename());
        await download.saveAs(filePath);
        logOk(`  скачан: ${filePath}`);
        const amount = await extractAmountFromInvoiceFile(filePath, parseOpts);
        if (amount !== null) out.push({ amount, fileName: text || path.basename(filePath) });
      } catch (err) {
        logWarn(`  вложение «${text}»: ${err.message || err}`);
      }
    }
  } catch (err) {
    logWarn(`  panel download: ${err.message || err}`);
  }
  return out;
}

async function extractWarehouseAmount(page, dealFrame, task) {
  const fromCard = extractWriteOffAmountFromText(task.sectionText || task.fingerprint || '');
  if (fromCard !== null) {
    log(`  сумма списания из ленты: ${fromCard}`);
    return fromCard;
  }

  if (!(await openTask(page, dealFrame, task))) {
    logWarn('  задачу списания не открыл');
    return null;
  }

  // ждём появления текста с суммой/всего в панели (не sleep)
  let found = null;
  await waitUntil(
    async () => {
      for (const frame of page.frames()) {
        try {
          const t = await frame.evaluate(() => document.body?.innerText || '');
          if (!t || t.length < 20) continue;
          const amount = extractWriteOffAmountFromText(t);
          if (amount !== null) {
            found = amount;
            return true;
          }
        } catch {
          // ignore
        }
      }
      const text = await page.evaluate(() => {
        const panel =
          document.querySelector(
            '.side-panel-content, .side-panel, [class*="side-panel"], .task-detail'
          ) || document.body;
        return panel.innerText || '';
      });
      const amount = extractWriteOffAmountFromText(text);
      if (amount !== null) {
        found = amount;
        return true;
      }
      return false;
    },
    { timeoutMs: 12000, intervalMs: 250 }
  );

  await closeSidePanel(page);
  return found;
}

/** Для списания: «сумма» / «всего» / «итого», не цена позиции. */
function extractWriteOffAmountFromText(text) {
  const s = String(text || '');
  const patterns = config.warehouseAmountRegexes || [];
  let best = null;
  for (const re of patterns) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const globalRe = new RegExp(re.source, flags);
    let m;
    while ((m = globalRe.exec(s)) !== null) {
      const v = parseMoney(m[1]);
      if (!isPlausibleMoney(v)) continue;
      if (best === null || v > best) best = v;
    }
  }
  return best;
}

/** СДЭК / транспорт из комментариев → [{ amount, snippet }]. */
function extractCdekAmountsFromComments(comments) {
  const hints = (config.cdekCommentHints || []).map((h) => normalize(h));
  const moneyToken =
    '([0-9]{1,3}(?:[\\s\\u00A0][0-9]{3})+(?:[.,][0-9]+)?|[0-9]+[.,][0-9]{2}|[0-9]{2,7}(?:[.,][0-9]+)?)';
  const nearCdek = new RegExp(
    `(?:сдэк|cdek|сдек)[^0-9]{0,40}${moneyToken}|${moneyToken}[^0-9]{0,20}(?:сдэк|cdek|сдек)`,
    'gi'
  );
  const out = [];
  const seen = new Set();

  for (const raw of comments || []) {
    const low = normalize(raw);
    if (!hints.some((h) => low.includes(h))) continue;

    let m;
    nearCdek.lastIndex = 0;
    while ((m = nearCdek.exec(raw)) !== null) {
      const rawNum = m[1] || m[2];
      const v = parseMoney(rawNum);
      if (!isPlausibleMoney(v) || v < 10) continue;
      const key = String(v);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ amount: v, snippet: String(raw).slice(0, 120) });
    }

    // fallback: в коротком комментарии про сдэк — любая сумма
    if (!out.length && String(raw).length < 200) {
      const moneyRe = new RegExp(moneyToken, 'g');
      while ((m = moneyRe.exec(raw)) !== null) {
        const v = parseMoney(m[1]);
        if (!isPlausibleMoney(v) || v < 10) continue;
        const key = String(v);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ amount: v, snippet: String(raw).slice(0, 120) });
      }
    }
  }

  return out;
}

/**
 * НАЛ/QR: в комментарии есть «3% за эквайринг» →
 * в сверку идёт 3% от суммы сделки (в графе Поставщик эта сумма уже лежит готовой).
 */
function extractAcquiringFeesFromComments(comments, dealAmount) {
  const re = config.acquiringCommentRegex;
  const pct = Number(config.acquiringFeePercent) || 3;
  if (!re || !isPlausibleMoney(dealAmount)) return [];

  const hasComment = (comments || []).some((raw) => re.test(String(raw || '')));
  if (!hasComment) return [];

  const fee = Math.round(dealAmount * (pct / 100) * 100) / 100;
  if (!isPlausibleMoney(fee)) return [];

  return [
    {
      amount: fee,
      base: dealAmount,
      snippet: '3% за эквайринг от суммы сделки',
    },
  ];
}

function extractLabeledAmount(text, { strict = false } = {}) {
  const s = String(text || '');
  const moneyToken =
    '([0-9]{1,3}(?:[\\s\\u00A0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+[.,][0-9]{2}|[0-9]{2,7}(?:[.,][0-9]{1,2})?)';
  const patterns = [
    ...(config.warehouseAmountRegexes || []),
    new RegExp(
      `(?:итого|всего\\s+к\\s+оплате|сумма(?:\\s*с\\s*ндс)?|к\\s+оплате)\\s*[:\\-]?\\s*${moneyToken}`,
      'i'
    ),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const v = parseMoney(m[1]);
    if (!isPlausibleMoney(v)) continue;
    if (strict) {
      const labeledItogo = /итого|всего|сумма|к\s+оплате/i.test(m[0]);
      if (!labeledItogo && Number.isInteger(v)) continue;
    }
    return v;
  }
  return null;
}

async function openTask(page, dealFrame, task) {
  try {
    const ctx = dealFrame || page;
    if (task.href) {
      const link = ctx.locator(`a[href="${task.href}"]`).first();
      if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
        await link.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        return true;
      }
      const partial = ctx
        .locator(`a[href*="/tasks/task/view/"]`)
        .filter({ hasText: task.title || '' })
        .first();
      if (await partial.isVisible({ timeout: 500 }).catch(() => false)) {
        await partial.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        return true;
      }
    }

    if (task.title) {
      const byTitle = ctx.locator(`a:has-text("${task.title}")`).first();
      if (await byTitle.isVisible({ timeout: 600 }).catch(() => false)) {
        await byTitle.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        return true;
      }
    }

    const openBtn = ctx.locator('text=Открыть').first();
    if (await openBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await openBtn.click({ timeout: 2000 });
      await page.waitForTimeout(600);
      return true;
    }
  } catch (err) {
    logWarn(`  openTask: ${err.message || err}`);
  }
  return false;
}

async function closeSidePanel(page) {
  try {
    const close = page
      .locator(
        '.side-panel-label-icon-close, .side-panel-close, [class*="side-panel"] .ui-icon-btn-close, button[title="Закрыть"]'
      )
      .first();
    if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
      await close.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch {
    // ignore
  }
}

module.exports = { checkDeal };
