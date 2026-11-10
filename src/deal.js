const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const { normalize, parseMoney, compareAmountSets, isPlausibleMoney, waitUntil, settleAfterAction } = require('./utils');
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

function addIssue(result, comment, detail) {
  if (result.issues.some((i) => i.detail === detail)) return;
  result.ok = false;
  result.issues.push({ comment, detail });
  result.errors.push(detail);
  log(`${comment}: ${detail}`);
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
  await waitForDealFields(dealFrame, config.dealFieldsTimeoutMs || 20000);

  // дальше только после реальных сумм в графах затрат (не «не заполнено»)
  logStep('поля', 'жду суммы Поставщик / расходы...');
  let costsReady = await waitForCostAmounts(
    dealFrame,
    config.costFieldLabels,
    config.costAmountsTimeoutMs || 30000
  );

  if (!costsReady) {
    // iframe мог пересоздаться — перехватываем и ждём ещё
    logWarn('суммы не появились — перечитываю iframe');
    const live = await resolveDealFrame(page, deal.url, config.dealOpenTimeoutMs || 10000);
    if (live) dealFrame = live;
    costsReady = await waitForCostAmounts(
      dealFrame,
      config.costFieldLabels,
      config.costRetryTimeoutMs || 20000
    );
  }

  logStep('поля', 'читаю карточку...');
  let { dealName, closeMonth, dealAmount, costFields } = await readDealCardData(dealFrame, deal);

  if (!costFields.length) {
    // последний шанс: ещё раз expand + wait + read
    await expandEditorSections(dealFrame);
    costsReady = await waitForCostAmounts(
      dealFrame,
      config.costFieldLabels,
      config.costLastChanceTimeoutMs || 15000
    );
    const again = await readDealCardData(dealFrame, deal);
    dealName = again.dealName || dealName;
    closeMonth = again.closeMonth || closeMonth;
    dealAmount = again.dealAmount || dealAmount;
    costFields = again.costFields;
  }

  if (!costFields.length) {
    addIssue(
      result,
      'не прочитались графы затрат',
      'Не удалось прочитать суммы из граф затрат (Поставщик, доп. расходы, доставка): блок «Товары и маржинальность» не отрисовался'
    );
    result.details.dealName = dealName;
    result.details.closeMonth = closeMonth;
    result.details.dealAmount = dealAmount;
    result.details.costFields = costFields;
    return result; // без сверки с пустыми графами — это ложные ошибки
  }

  logStep('таймлайн', 'жду ленту...');
  await waitForTimelineReady(dealFrame, config.timelineTimeoutMs || 12000);
  await scrollTimelineInFrame(dealFrame, config.timelineScrollSteps || 4);

  const wantDiag =
    config.frameDiagnostics || config.verbose || process.env.DEBUG_DIAG === '1' || process.env.VERBOSE === '1';
  const diag = wantDiag
    ? await dumpFrameDiagnostics(dealFrame)
    : { hasAbout: true, hasMonth: true };
  if (wantDiag) {
    log(
      `  iframe diag: len=${diag.len}, titles=${diag.titleCount}, stream=${diag.streamCount}, ` +
        `о_сделке=${diag.hasAbout}, месяц=${diag.hasMonth}, поставщик=${diag.hasSupplier}, ` +
        `счёт=${diag.hasInvoice}, предоплата=${diag.hasPrepay}`
    );
  }

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
      'не заполнен месяц завершения',
      `Не заполнено поле «${config.closeMonthLabel}» в блоке «О сделке»`
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
        'нет счёта заказчику',
        `В ленте нет комментария «счёт заказчику» с вложенным файлом исходящего счёта${
          dealName ? ` (в имени файла должен быть номер сделки «${dealName}»)` : ''
        }`
      );
    } else if (
      clientInvoice.fileName &&
      dealName &&
      !normalize(clientInvoice.fileName).includes(normalize(dealName))
    ) {
      addIssue(
        result,
        'не тот счёт заказчику',
        `Номер в файле счёта заказчику не совпадает со сделкой: сделка «${dealName}», файл «${clientInvoice.fileName}»`
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
        'не прочитан счёт поставщику',
        `В задаче «${task.title}» не удалось прочитать итоговую сумму из вложенных счетов поставщика (Excel, PDF или Word)`
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
  const warehouseHints =
    config.warehouseTaskHints && config.warehouseTaskHints.length
      ? config.warehouseTaskHints
      : [config.warehouseTaskHint].filter(Boolean);
  logStep('списание', `ищу задачи: ${warehouseHints.join(', ')}`);
  const writeOffTasks = await findPaymentTasksInFrame(dealFrame, warehouseHints, dealName, {
    // в карточке списания название сделки часто не дублируется
    requireDealName: false,
  });
  log(`  найдено задач списания: ${writeOffTasks.length}`);

  const writeOffAmounts = [];
  for (const task of writeOffTasks) {
    logStep('списание', `ищу «сумма/всего …» — «${task.title}»`);
    const amount = await extractWarehouseAmount(page, dealFrame, task, preferAmounts);
    log(amount !== null ? `  сумма списания = ${amount}` : '  сумма/всего не найдены');
    writeOffAmounts.push({ title: task.title, amount });
    if (amount === null) {
      addIssue(
        result,
        'нет суммы списания',
        `В задаче «${task.title}» нет итога списания в формате «сумма …», «всего …» или «итого …» (нужна общая сумма, не цена одной позиции)`
      );
    }
  }
  result.details.writeOffTasks = writeOffAmounts;

  // --- 3b. Комментарии: СДЭК + 3% эквайринг (НАЛ/QR) ---
  logStep('комментарии', 'читаю ленту (СДЭК / эквайринг)...');
  const comments = await readTimelineComments(dealFrame);
  const cdekAmounts = extractCdekAmountsFromComments(comments);
  const acquiringAmounts = shouldSkipClientInvoice(dealName || deal.title || '')
    ? extractAcquiringFeesFromComments(comments, dealAmount, preferAmounts)
    : [];
  result.details.commentAmounts = { cdek: cdekAmounts, acquiring: acquiringAmounts };
  if (cdekAmounts.length) {
    log(`  СДЭК из комментариев: ${cdekAmounts.map((x) => x.amount).join(', ')}`);
  }
  if (acquiringAmounts.length) {
    log(
      `  эквайринг 3% от суммы сделки (${dealAmount}): ${acquiringAmounts.map((x) => x.amount).join(', ')}` +
        (acquiringAmounts[0]?.snapped ? ' (подогнано под графу ±1₽)' : '')
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
        'не сходится сумма в счёте поставщику и в списке затрат',
        `В счетах и задачах есть суммы [${cmp.sourceSorted.join(', ')}], а список затрат пустой`
      );
    } else if (!sourceAmounts.length && fieldAmounts.length) {
      addIssue(
        result,
        'не сходится сумма в счёте поставщику и в списке затрат',
        `В списке затрат есть суммы [${cmp.fieldsSorted.join(', ')}], а в счетах поставщика, предоплате, постоплате и списании таких сумм нет`
      );
    } else {
      const parts = [];
      if (cmp.missingInFields.length) {
        parts.push(
          `в списке затрат нет сумм из счетов и задач: ${cmp.missingInFields.join(', ')}`
        );
      }
      if (cmp.extraInFields.length) {
        parts.push(
          `в списке затрат есть суммы, которых нет в счетах и задачах: ${cmp.extraInFields.join(', ')}`
        );
      }
      if (parts.length) {
        addIssue(
          result,
          'не сходится сумма в счёте поставщику и в списке затрат',
          `Не сходится сумма: ${parts.join('; ')}. Счета и задачи: [${cmp.sourceSorted.join(', ')}], список затрат: [${cmp.fieldsSorted.join(', ')}]`
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

async function extractWarehouseAmount(page, dealFrame, task, preferAmounts = []) {
  // Текст описания почти всегда только внутри открытой задачи —
  // превью в ленте часто без «сумма/всего» или с одной «ценой».
  let found = null;

  if (await openTask(page, dealFrame, task)) {
    await waitUntil(
      async () => {
        const chunks = await collectTaskBodyTexts(page);
        for (const chunk of chunks) {
          const amount = extractWriteOffAmountFromText(chunk, preferAmounts);
          if (amount !== null) {
            found = amount;
            log(`  сумма списания из текста задачи: ${amount}`);
            return true;
          }
        }
        return false;
      },
      { timeoutMs: 12000, intervalMs: 250 }
    );
    await closeSidePanel(page);
  } else {
    logWarn('  задачу списания не открыл — пробую текст из ленты');
  }

  if (found !== null) return found;

  const fromCard = extractWriteOffAmountFromText(
    task.sectionText || task.fingerprint || '',
    preferAmounts
  );
  if (fromCard !== null) {
    log(`  сумма списания из ленты: ${fromCard}`);
    return fromCard;
  }
  return null;
}

/** Собираем текст описания задачи (не весь DOM портала). */
async function collectTaskBodyTexts(page) {
  const chunks = [];

  const grab = async (ctx) => {
    try {
      const parts = await ctx.evaluate(() => {
        const out = [];
        const push = (t) => {
          const s = String(t || '')
            .replace(/\u00A0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim();
          if (s.length >= 3) out.push(s);
        };

        const sels = [
          '.task-detail-description',
          '.task-detail-description-text',
          '[class*="task-detail-description"]',
          '.tasks-frame-view-description',
          '[data-bx-id*="description"]',
          '.task-detail-content',
          '.task-public-content',
          '.ui-editor-content-block',
          '.tasks-task-view-description',
          '.side-panel-content-container .task-detail',
          '.side-panel-content .task-detail',
        ];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) push(el.innerText || el.textContent || '');
        }

        // если спец. блоков нет — весь контент панели задачи
        if (!out.length) {
          const panel =
            document.querySelector(
              '.side-panel-content-container, .side-panel-content, .task-detail, [class*="side-panel"]'
            ) || document.body;
          push(panel?.innerText || '');
        }
        return out;
      });
      chunks.push(...parts);
    } catch {
      // ignore
    }
  };

  await grab(page);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url() || '';
    if (!/task|IFRAME|SIDE_SLIDER/i.test(url) && !/about:blank/i.test(url)) continue;
    await grab(frame);
  }

  // уникальные куски, сначала более короткие описания (меньше мусора)
  const uniq = [];
  const seen = new Set();
  for (const c of chunks.sort((a, b) => a.length - b.length)) {
    const key = c.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  return uniq;
}

/**
 * Из текста задачи списания: только «сумма» / «всего» (+ «на сумму»).
 * «Цена» и строки только с ценой позиции — игнорируем.
 * Важно: в JS \\b не работает с кириллицей — границы через класс букв.
 */
function extractWriteOffAmountFromText(text, preferAmounts = []) {
  const raw = String(text || '').replace(/\u00A0/g, ' ');
  if (!raw.trim()) return null;

  const moneyTok =
    config.warehouseMoneyToken ||
    '([0-9]{1,3}(?:[\\s\\u00A0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+[.,][0-9]{1,2}|[0-9]{1,9}(?:[.,][0-9]{1,2})?)';
  // граница «слова» для кириллицы
  const B = '(?:^|[^0-9A-Za-zА-Яа-яЁё])';
  const E = '(?=[^0-9A-Za-zА-Яа-яЁё]|$)';

  const labeled = [
    new RegExp(
      `${B}всего${E}\\s*(?:к\\s*(?:оплате|списанию)|по\\s*списанию|списан[оа]?)?\\s*[:\\-=]?\\s*${moneyTok}`,
      'gi'
    ),
    new RegExp(
      `${B}сумма${E}\\s*(?:списания|итого|общая|к\\s*списанию)?\\s*[:\\-=]?\\s*${moneyTok}`,
      'gi'
    ),
    new RegExp(`${B}на\\s+сумму\\s*[:\\-=]?\\s*${moneyTok}`, 'gi'),
    new RegExp(`(?:^|[\\n\\r;|/])\\s*(?:сумма|всего)\\s*[:\\-=]?\\s*${moneyTok}`, 'gi'),
  ];

  const candidates = [];
  const seen = new Set();

  const push = (v) => {
    if (!isPlausibleMoney(v)) return;
    const key = String(Math.round(v * 100) / 100);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(v);
  };

  const isPriceContext = (around) => {
    const low = String(around || '').toLowerCase().replace(/ё/g, 'е');
    const hasPrice = new RegExp(`${B}цена${E}`, 'i').test(low);
    const hasSum =
      new RegExp(`${B}сумма${E}`, 'i').test(low) ||
      new RegExp(`${B}всего${E}`, 'i').test(low) ||
      /на\s+сумму/i.test(low);
    return hasPrice && !hasSum;
  };

  for (const re of labeled) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const start = Math.max(0, m.index - 16);
      const end = Math.min(raw.length, m.index + m[0].length + 8);
      if (isPriceContext(raw.slice(start, end))) continue;
      push(parseMoney(m[1]));
    }
  }

  // построчно: только строки, где есть сумма/всего
  for (const line of raw.split(/\r?\n|;|\u2028|\u2029/)) {
    const low = line.toLowerCase().replace(/ё/g, 'е');
    const hasSum =
      new RegExp(`${B}сумма${E}`, 'i').test(low) ||
      new RegExp(`${B}всего${E}`, 'i').test(low) ||
      /на\s+сумму/i.test(low);
    if (!hasSum) continue;
    if (isPriceContext(low)) continue;

    const re = new RegExp(`(?:сумма|всего|на\\s+сумму)[^0-9]{0,24}${moneyTok}`, 'gi');
    let m;
    while ((m = re.exec(line)) !== null) {
      if (/цена/i.test(m[0]) && !/(сумма|всего)/i.test(m[0])) continue;
      push(parseMoney(m[1]));
    }
  }

  if (!candidates.length) {
    if (config.verbose) logWarn('  в тексте задачи нет «сумма»/«всего» с числом (цена игнорируется)');
    return null;
  }

  const tol = Math.max(Number(config.amountTolerance) || 0, 1);
  const prefers = (preferAmounts || []).filter((n) => Number.isFinite(n));
  if (prefers.length) {
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      for (const p of prefers) {
        const d = Math.abs(c - p);
        if (d <= tol && d < bestDist) {
          best = p;
          bestDist = d;
        }
      }
    }
    if (best !== null) return best;
  }

  return candidates.reduce((a, b) => (a > b ? a : b), candidates[0]);
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
 * НАЛ/QR: в комментарии намёк на эквайринг / 3% →
 * в сверку идёт 3% от суммы сделки. Если в графе есть сумма в пределах ±1 ₽ —
 * берём её (округление Битрикса).
 */
function extractAcquiringFeesFromComments(comments, dealAmount, preferAmounts = []) {
  const pct = Number(config.acquiringFeePercent) || 3;
  if (!isPlausibleMoney(dealAmount)) return [];

  const regexes = [
    ...(config.acquiringCommentRegexes || []),
    config.acquiringCommentRegex,
  ].filter(Boolean);

  let matchedSnippet = '';
  for (const raw of comments || []) {
    const text = String(raw || '');
    if (!text) continue;
    if (regexes.some((re) => re.test(text))) {
      matchedSnippet = text.slice(0, 160);
      break;
    }
    // ещё мягче: «3%» + «эквайр» / «терминал» / «картой» в одном комментарии
    const low = normalize(text);
    if (
      /3\s*%/.test(low) &&
      (low.includes('эквайр') || low.includes('терминал') || low.includes('картой') || low.includes('безнал'))
    ) {
      matchedSnippet = text.slice(0, 160);
      break;
    }
  }
  if (!matchedSnippet) return [];

  let fee = Math.round(dealAmount * (pct / 100) * 100) / 100;
  // альтернативные округления, которые любит Битрикс
  const variants = [
    fee,
    Math.round(dealAmount * (pct / 100)),
    Math.floor(dealAmount * (pct / 100) * 100) / 100,
    Math.ceil(dealAmount * (pct / 100) * 100) / 100,
  ];

  const tol = Math.max(Number(config.amountTolerance) || 0, 1);
  const prefers = (preferAmounts || []).filter((n) => Number.isFinite(n));
  let snapped = false;
  if (prefers.length) {
    let best = null;
    let bestDist = Infinity;
    for (const v of variants) {
      for (const p of prefers) {
        const d = Math.abs(v - p);
        if (d <= tol && d < bestDist) {
          best = p;
          bestDist = d;
        }
      }
    }
    if (best !== null) {
      fee = best;
      snapped = true;
    }
  }

  if (!isPlausibleMoney(fee)) return [];

  return [
    {
      amount: fee,
      base: dealAmount,
      snapped,
      snippet: matchedSnippet || '3% за эквайринг от суммы сделки',
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

async function waitTaskPanel(page) {
  await settleAfterAction(
    async () => {
      const n = page.frames().filter((f) => /IFRAME=Y|SIDE_SLIDER|\/tasks\//i.test(f.url())).length;
      return n > 0;
    },
    { minMs: config.uiSettleMs || 200, maxMs: config.uiSettleTimeoutMs || 3000 }
  );
}

async function openTask(page, dealFrame, task) {
  try {
    const ctx = dealFrame || page;
    if (task.href) {
      const link = ctx.locator(`a[href="${task.href}"]`).first();
      if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
        await link.click({ timeout: 3000 });
        await waitTaskPanel(page);
        return true;
      }
      const partial = ctx
        .locator(`a[href*="/tasks/task/view/"]`)
        .filter({ hasText: task.title || '' })
        .first();
      if (await partial.isVisible({ timeout: 500 }).catch(() => false)) {
        await partial.click({ timeout: 3000 });
        await waitTaskPanel(page);
        return true;
      }
    }

    if (task.title) {
      const byTitle = ctx.locator(`a:has-text("${task.title}")`).first();
      if (await byTitle.isVisible({ timeout: 600 }).catch(() => false)) {
        await byTitle.click({ timeout: 3000 });
        await waitTaskPanel(page);
        return true;
      }
    }

    const openBtn = ctx.locator('text=Открыть').first();
    if (await openBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await openBtn.click({ timeout: 2000 });
      await waitTaskPanel(page);
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
      await settleAfterAction(null, { minMs: config.uiSettleMs || 200, maxMs: config.uiSettleMs || 200 });
      return;
    }
    await page.keyboard.press('Escape');
    await settleAfterAction(null, { minMs: Math.min(200, config.uiSettleMs || 200), maxMs: 200 });
  } catch {
    // ignore
  }
}

module.exports = { checkDeal };
