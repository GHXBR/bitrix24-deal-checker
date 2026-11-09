const { log, logStep, logOk, logWarn } = require('./log');

/**
 * Собирает ссылки на сделки из страницы отчёта Битрикс24.
 * Отчёты часто режут по 10 строк — обходим все страницы пагинации.
 */

async function waitForReportReady(page, timeoutMs) {
  logStep('отчёт', `жду появления ссылок /crm/deal/details/ (таймаут ${timeoutMs} мс)`);
  await page.waitForFunction(
    () => {
      const links = Array.from(document.querySelectorAll('a[href*="/crm/deal/details/"]')).filter(
        (a) => /\/crm\/deal\/details\/([1-9]\d*)\/?/.test(a.href)
      );
      return links.length > 0;
    },
    { timeout: timeoutMs }
  );
  const count = await page.locator('a[href*="/crm/deal/details/"]').count();
  logOk(`условие готово, ссылок на сделки на странице: ${count}`);
}

async function collectDealLinks(page) {
  logStep('отчёт', 'включаю «показать все» / максимум строк на странице');
  await forceShowAllInUrl(page);
  await tryShowAll(page);
  await trySetPageSize(page);

  const all = new Map();
  let pageNo = 1;
  const maxPages = 50;

  while (pageNo <= maxPages) {
    logStep('отчёт', `читаю страницу списка #${pageNo}...`);
    const batch = await scrapeDealsOnPage(page);
    let added = 0;
    for (const d of batch.deals) {
      if (!all.has(d.id)) {
        all.set(d.id, d);
        added++;
      }
    }
    log(
      `  на странице якорей=${batch.totalAnchors}, новых=${added}, всего уникальных=${all.size}`
    );

    const wentNext = await goToNextReportPage(page);
    if (!wentNext) {
      logOk('следующей страницы нет — сбор закончен');
      break;
    }
    pageNo++;
    await page.waitForTimeout(600);
  }

  if (pageNo > maxPages) {
    logWarn(`достигнут лимит ${maxPages} страниц пагинации`);
  }

  logOk(`итого уникальных сделок: ${all.size}`);
  return Array.from(all.values());
}

async function scrapeDealsOnPage(page) {
  return page.evaluate(() => {
    const map = new Map();
    const skipped = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="/crm/deal/details/"]'));
    for (const a of anchors) {
      const href = a.href;
      const match = href.match(/\/crm\/deal\/details\/(\d+)\/?/);
      if (!match) continue;
      const id = match[1];
      if (!id || id === '0') {
        skipped.push(href);
        continue;
      }
      if (map.has(id)) continue;

      const row = a.closest('tr') || a.closest('[class*="row"]') || a.parentElement;
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim() || `Сделка #${id}`;
      const rowText = row ? (row.innerText || '').replace(/\s+/g, ' ').trim() : '';

      map.set(id, {
        id,
        title,
        url: href.split('?')[0],
        rowText,
      });
    }
    return {
      deals: Array.from(map.values()),
      totalAnchors: anchors.length,
      skipped,
    };
  });
}

async function forceShowAllInUrl(page) {
  try {
    const url = new URL(page.url());
    let changed = false;
    if (url.searchParams.get('SHOWALL_1') !== '1') {
      url.searchParams.set('SHOWALL_1', '1');
      changed = true;
    }
    // классические отчёты Битрикс: sizе / nPageSize
    for (const key of ['nPageSize', 'SIZEN_1', 'page_size']) {
      if (!url.searchParams.has(key) || Number(url.searchParams.get(key)) < 100) {
        url.searchParams.set(key, '500');
        changed = true;
      }
    }
    if (changed) {
      log(`  обновляю URL отчёта: SHOWALL / page size → ${url.toString().slice(0, 120)}...`);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(700);
    }
  } catch (err) {
    logWarn(`  forceShowAllInUrl: ${err.message || err}`);
  }
}

async function tryShowAll(page) {
  const candidates = [
    'text=Показать все',
    'text=показать все',
    'a:has-text("Показать все")',
    'span:has-text("Показать все")',
    'a:has-text("все")',
  ];

  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        log(`  клик по «${sel}»`);
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        logOk('пагинация: «показать все»');
        return;
      }
    } catch {
      // ignore
    }
  }
  log('  кнопка «показать все» не найдена');
}

async function trySetPageSize(page) {
  // выпадашки «по 10 / 20 / 50» внизу отчёта
  const sizeSelectors = [
    'select[name*="SIZEN"]',
    'select[name*="nPageSize"]',
    'select[name*="page_size"]',
    '.modern-page-navigation select',
    '.bx-pagination select',
  ];
  for (const sel of sizeSelectors) {
    try {
      const select = page.locator(sel).first();
      if (!(await select.isVisible({ timeout: 500 }))) continue;
      const options = await select.locator('option').allTextContents();
      log(`  найден select размера страницы: ${options.join(', ')}`);
      // берём максимальное числовое значение
      const values = await select.locator('option').evaluateAll((opts) =>
        opts.map((o) => ({ value: o.value, text: o.textContent || '' }))
      );
      let best = null;
      for (const o of values) {
        const n = Number(String(o.value || o.text).replace(/\D/g, ''));
        if (!Number.isFinite(n)) continue;
        if (!best || n > best.n) best = { ...o, n };
      }
      if (best) {
        await select.selectOption(best.value || String(best.n));
        await page.waitForTimeout(800);
        logOk(`  выбрано строк на странице: ${best.n}`);
        return;
      }
    } catch {
      // ignore
    }
  }

  // клик по ссылке «50» / «100» рядом с «На странице»
  for (const n of [500, 100, 50, 20]) {
    try {
      const link = page.locator(`a:has-text("${n}")`).first();
      if (await link.isVisible({ timeout: 300 })) {
        const box = await link.boundingBox();
        // грубый фильтр: пагинация обычно внизу
        if (box && box.y > 200) {
          log(`  клик по размеру страницы «${n}»`);
          await link.click({ timeout: 1500 });
          await page.waitForTimeout(800);
          return;
        }
      }
    } catch {
      // ignore
    }
  }
}

async function goToNextReportPage(page) {
  const before = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('a[href*="/crm/deal/details/"]'))
      .map((a) => (a.href.match(/\/crm\/deal\/details\/(\d+)/) || [])[1])
      .filter(Boolean);
    return ids.slice(0, 5).join(',');
  });

  const nextCandidates = [
    'a.modern-page-next',
    'a.bx-pag-next',
    '.modern-page-navigation a:has-text("След")',
    'a:has-text("Следующая")',
    'a:has-text("следующая")',
    'a:has-text(">")',
    'button:has-text("След")',
    '[class*="pagination"] a:has-text("›")',
    '[class*="pagination"] a:has-text(">")',
  ];

  for (const sel of nextCandidates) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 400 }))) continue;
      const cls = (await el.getAttribute('class')) || '';
      const aria = (await el.getAttribute('aria-disabled')) || '';
      if (/disabled|no-active|modern-page-current/i.test(cls) || aria === 'true') continue;

      log(`  клик «следующая страница» (${sel})`);
      await el.click({ timeout: 2000 });
      await page.waitForTimeout(700);

      const after = await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll('a[href*="/crm/deal/details/"]'))
          .map((a) => (a.href.match(/\/crm\/deal\/details\/(\d+)/) || [])[1])
          .filter(Boolean);
        return ids.slice(0, 5).join(',');
      });
      if (after && after !== before) {
        logOk('страница списка сменилась');
        return true;
      }
      // иногда контент тот же — считаем что следующей нет
      logWarn('клик был, но список не изменился');
    } catch {
      // ignore
    }
  }

  // номерные ссылки 2, 3, …
  try {
    const numbered = page.locator(
      '.modern-page-navigation a, .bx-pagination a, [class*="page-navigation"] a'
    );
    const count = await numbered.count();
    for (let i = 0; i < count; i++) {
      const a = numbered.nth(i);
      const text = ((await a.innerText()) || '').trim();
      const cls = (await a.getAttribute('class')) || '';
      if (!/^\d+$/.test(text)) continue;
      if (/current|active|selected/i.test(cls)) continue;
      // берём первую неактивную большую, чем текущая — упрощаем: кликаем первую не-current цифру после current
      const isCurrentSibling = await a.evaluate((el) => {
        const cur = el.parentElement?.querySelector(
          '.modern-page-current, .bx-pag-current, .active, [aria-current="page"]'
        );
        if (!cur) return Number(el.textContent) === 2;
        return Number(el.textContent) === Number(cur.textContent) + 1;
      });
      if (!isCurrentSibling) continue;

      log(`  клик по номеру страницы «${text}»`);
      await a.click({ timeout: 2000 });
      await page.waitForTimeout(700);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

module.exports = {
  waitForReportReady,
  collectDealLinks,
};
