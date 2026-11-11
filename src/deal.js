const config = require('../config');
const {
  normalize,
  parseMoney,
  compareAmountSets,
  sanitizeSourceEntries,
  formatSourceOrigins,
} = require('./utils');
const { log, logStep, logOk, logWarn } = require('./log');
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
const {
  shouldSkipClientInvoice,
  resolveCashDealAmount,
  extractCdekAmountsFromComments,
  extractAcquiringFeesFromComments,
} = require('./moneySources');
const { extractAllSupplierInvoiceAmounts, extractWarehouseAmount } = require('./dealFiles');

function addIssue(result, comment, detail) {
  if (result.issues.some((i) => i.detail === detail)) return;
  result.ok = false;
  result.issues.push({ comment, detail });
  result.errors.push(detail);
  log(`${comment}: ${detail}`);
}

async function liveFrame(page, dealUrl, dealFrame) {
  const live = await resolveDealFrame(page, dealUrl, 4000).catch(() => null);
  return live || dealFrame;
}

async function readDealCardData(dealFrame, deal) {
  await expandEditorSections(dealFrame);
  const fields = await readFieldsFromFrame(dealFrame);
  const fallback = async (label, cur) => cur || (await readFieldByTextFallback(dealFrame, label)) || '';

  let dealName = await fallback(config.dealNameLabel, fields[config.dealNameLabel]);
  if (!dealName) dealName = deal.title || '';
  const closeMonth = await fallback(config.closeMonthLabel, fields[config.closeMonthLabel]);
  const dealAmountText = await fallback(config.dealAmountLabel, fields[config.dealAmountLabel]);
  const costFields = await readCostFieldsFromFrame(dealFrame, config.costFieldLabels, fields);

  return {
    fields,
    dealName,
    closeMonth,
    dealAmount: parseMoney(dealAmountText),
    dealAmountText,
    costFields,
  };
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

    logStep('поля', 'жду суммы Поставщик / расходы...');
    let costsReady = await waitForCostAmounts(
      dealFrame,
      config.costFieldLabels,
      config.costAmountsTimeoutMs || 30000
    );

    if (!costsReady) {
      logWarn('суммы не появились — перечитываю iframe');
      dealFrame = await liveFrame(page, deal.url, dealFrame);
      costsReady = await waitForCostAmounts(
        dealFrame,
        config.costFieldLabels,
        config.costRetryTimeoutMs || 20000
      );
    }

    logStep('поля', 'читаю карточку...');
    let { dealName, closeMonth, dealAmount, costFields } = await readDealCardData(dealFrame, deal);

    if (!costFields.length) {
      await expandEditorSections(dealFrame);
      await waitForCostAmounts(dealFrame, config.costFieldLabels, config.costLastChanceTimeoutMs || 15000);
      const again = await readDealCardData(dealFrame, deal);
      dealName = again.dealName || dealName;
      closeMonth = again.closeMonth || closeMonth;
      dealAmount = again.dealAmount || dealAmount;
      costFields = again.costFields;
    }

    if (!costFields.length) {
      result.checkFailed = true;
      addIssue(
        result,
        'не удалось проверить сделку',
        'Не удалось прочитать суммы из граф затрат (Поставщик, доп. расходы, доставка): блок «Товары и маржинальность» не отрисовался'
      );
      Object.assign(result.details, { dealName, closeMonth, dealAmount, costFields });
      return result;
    }

    logStep('таймлайн', 'жду ленту...');
    await waitForTimelineReady(dealFrame, config.timelineTimeoutMs || 12000);
    await scrollTimelineInFrame(dealFrame, config.timelineScrollSteps || 4);

    const wantDiag =
      config.verbose || process.env.DEBUG_DIAG === '1' || process.env.VERBOSE === '1';
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
    log(dealAmount != null ? `  сумма сделки = ${dealAmount}` : '  сумма сделки не найдена');
    costFields.forEach((f) => log(`    ${f.label} = «${f.valueText}» → ${f.amount}`));

    if (!diag.hasAbout || !diag.hasMonth) {
      const parts = await collectFrameTexts(page);
      saveDebugDump(
        deal.id,
        parts.map((p) => p.text).join('\n\n'),
        { dealUrl: deal.url, frameUrl: dealFrame.url(), ...diag },
        parts
      );
    }

    Object.assign(result.details, { dealName, closeMonth, dealAmount, costFields, pageDiag: diag });

    if (!closeMonth) {
      addIssue(
        result,
        'не заполнен месяц завершения',
        `Не заполнено поле «${config.closeMonthLabel}» в блоке «О сделке»`
      );
    } else {
      logOk('проверка: месяц завершения заполнен');
    }

    const skipClientInvoice = shouldSkipClientInvoice(dealName || deal.title || '');
    const preferAmounts = costFields.map((f) => f.amount).filter((n) => n !== null);
    const cashDealAmount = skipClientInvoice
      ? resolveCashDealAmount(dealAmount, dealName || deal.title, deal.title, preferAmounts)
      : dealAmount;
    if (skipClientInvoice) {
      log(`  база Нал/QR для эквайринга 3%: ${cashDealAmount ?? '—'} (поле суммы: ${dealAmount ?? '—'})`);
      result.details.dealAmountFromTitle = cashDealAmount;
    }

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
          `В ленте нет комментария «счёт заказчику»${
            dealName ? ` (ожидается исходящий счёт по сделке «${dealName}»)` : ''
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
        logOk('проверка: счёт заказчику найден (сумму не сверяем)');
      }
    }

    logStep('оплата поставщику', `ищу задачи: ${config.supplierPaymentTaskHints.join(', ')}`);
    const paymentTasks = await findPaymentTasksInFrame(
      dealFrame,
      config.supplierPaymentTaskHints,
      dealName,
      { requireDealName: !skipClientInvoice }
    );
    log(`  найдено задач оплаты: ${paymentTasks.length}`);
    paymentTasks.forEach((t, i) =>
      log(
        `  [${i + 1}] «${t.title}» файлов=${(t.files || []).length || (t.fileName ? 1 : 0)} «${(t.files || []).map((f) => f.fileName).join(' | ') || t.fileName || '—'}»`
      )
    );

    const sourceEntries = [];
    const paymentAmounts = [];
    for (const task of paymentTasks) {
      logStep('оплата поставщику', `суммы из вложений «${task.title}»`);
      dealFrame = await liveFrame(page, deal.url, dealFrame);
      const amounts = await extractAllSupplierInvoiceAmounts(page, dealFrame, task, preferAmounts);
      if (!amounts.length) {
        addIssue(
          result,
          'не прочитан счёт поставщику',
          `В задаче «${task.title}» не удалось прочитать итоговую сумму из вложенных счетов поставщика (Excel, PDF или Word)`
        );
      } else {
        for (const item of amounts) {
          log(`  файл «${item.fileName || '—'}» → ${item.amount}`);
          paymentAmounts.push({ title: task.title, amount: item.amount, fileName: item.fileName || '' });
          sourceEntries.push({ amount: item.amount, origin: `счёт «${item.fileName || task.title}»` });
        }
      }
    }
    result.details.paymentTasks = paymentAmounts;

    dealFrame = await liveFrame(page, deal.url, dealFrame);
    const warehouseHints =
      config.warehouseTaskHints?.length > 0
        ? config.warehouseTaskHints
        : [config.warehouseTaskHint].filter(Boolean);
    logStep('списание', `ищу задачи: ${warehouseHints.join(', ')}`);
    const writeOffTasks = await findPaymentTasksInFrame(dealFrame, warehouseHints, dealName, {
      requireDealName: false,
    });
    log(`  найдено задач списания: ${writeOffTasks.length}`);

    const writeOffAmounts = [];
    for (const task of writeOffTasks) {
      logStep('списание', `ищу «сумма/всего …» — «${task.title}»`);
      dealFrame = await liveFrame(page, deal.url, dealFrame);
      const amount = await extractWarehouseAmount(page, dealFrame, task, preferAmounts);
      log(amount !== null ? `  сумма списания = ${amount}` : '  сумма/всего не найдены');
      writeOffAmounts.push({ title: task.title, amount });
      if (amount === null) {
        addIssue(
          result,
          'нет суммы списания',
          `В задаче «${task.title}» нет итога списания в формате «сумма …», «всего …» или «итого …» (нужна общая сумма, не цена одной позиции)`
        );
      } else {
        sourceEntries.push({ amount, origin: `списание «${task.title}»` });
      }
    }
    result.details.writeOffTasks = writeOffAmounts;

    dealFrame = await liveFrame(page, deal.url, dealFrame);
    logStep('комментарии', 'читаю ленту (СДЭК / эквайринг)...');
    const comments = await readTimelineComments(dealFrame);
    const cdekAmounts = extractCdekAmountsFromComments(comments);
    for (const x of cdekAmounts) {
      sourceEntries.push({ amount: x.amount, origin: `СДЭК «${(x.snippet || '').slice(0, 40)}»` });
    }

    const acquiringAmounts = skipClientInvoice
      ? extractAcquiringFeesFromComments(comments, cashDealAmount, preferAmounts, {
          dealName: dealName || deal.title,
          title: deal.title,
        })
      : [];
    for (const x of acquiringAmounts) {
      sourceEntries.push({
        amount: x.amount,
        origin: x.fromField ? 'эквайринг 3% (из графы)' : 'эквайринг 3% (расчёт)',
      });
    }
    result.details.commentAmounts = { cdek: cdekAmounts, acquiring: acquiringAmounts };
    if (cdekAmounts.length) log(`  СДЭК из комментариев: ${cdekAmounts.map((x) => x.amount).join(', ')}`);
    if (acquiringAmounts.length) {
      log(
        `  эквайринг 3% от ${cashDealAmount}: ${acquiringAmounts.map((x) => x.amount).join(', ')}` +
          (acquiringAmounts[0]?.fromField ? ' (взято из графы)' : '') +
          (acquiringAmounts[0]?.snapped ? ' (±1₽)' : '')
      );
    } else if (skipClientInvoice) {
      logWarn(`  эквайринг 3% не найден (база суммы сделки: ${cashDealAmount ?? '—'})`);
    }

    const fieldAmounts = costFields
      .map((f) => f.amount)
      .filter((n) => n !== null && Math.abs(n) >= 0.0001);

    const { kept, dropped } = sanitizeSourceEntries(sourceEntries, fieldAmounts, {
      minSourceAmount: config.minSourceAmount,
      tolerance: config.amountTolerance,
      dropTinyOrphans: config.dropTinyOrphans,
      orphanMaxAmount: config.orphanMaxAmount,
      orphanMaxRatio: config.orphanMaxRatio,
    });
    if (dropped.length) {
      logWarn(
        `  отброшены сомнительные суммы: ${dropped
          .map((d) => `${d.amount} (${d.reason}; ${d.origin || '?'})`)
          .join('; ')}`
      );
    }

    const sourceAmounts = kept.map((e) => e.amount);
    Object.assign(result.details, {
      sourceEntries: kept,
      sourceDropped: dropped,
      sourceAmounts,
      sourceOrigins: formatSourceOrigins(kept),
      fieldAmounts,
    });

    logStep(
      'сверка',
      `источники ${JSON.stringify([...sourceAmounts].sort((a, b) => a - b))} ↔ графы ${JSON.stringify(
        [...fieldAmounts].sort((a, b) => a - b)
      )}`
    );
    if (kept.length) log(`  происхождение: ${formatSourceOrigins(kept)}`);

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
          `В счетах и задачах есть суммы [${cmp.sourceSorted.join(', ')}], а список затрат пустой. Источники: ${formatSourceOrigins(kept)}`
        );
      } else if (!sourceAmounts.length && fieldAmounts.length) {
        addIssue(
          result,
          'не сходится сумма в счёте поставщику и в списке затрат',
          `В списке затрат есть суммы [${cmp.fieldsSorted.join(', ')}], а в счетах поставщика, предоплате, постоплате, списании и эквайринге таких сумм нет`
        );
      } else {
        const parts = [];
        if (cmp.missingInFields.length) {
          parts.push(`в списке затрат нет сумм из счетов и задач: ${cmp.missingInFields.join(', ')}`);
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
            `Не сходится сумма: ${parts.join('; ')}. Источники: ${formatSourceOrigins(kept)}; список затрат: [${cmp.fieldsSorted.join(', ')}]`
          );
        }
      }
    }

    return result;
  } finally {
    await closeDealPanel(page, deal.id).catch(() => {});
  }
}

module.exports = { checkDeal };
