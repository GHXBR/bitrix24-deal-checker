/**
 * Скачивание вложений счетов и панель задачи.
 * Счета всегда читаем из файлов и сверяем с графами — из ленты только СДЭК/эквайринг.
 * Ускорение: кэш файла/суммы + параллельный fetch по href (лимит), клик — fallback.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const { waitUntil, settleAfterAction } = require('./utils');
const { extractAmountFromInvoiceFile } = require('./invoiceAmount');
const { extractWriteOffAmountFromText } = require('./moneySources');
const {
  normalizeHref,
  getCachedAmount,
  setCachedAmount,
  getCachedFile,
  setCachedFile,
  getInflight,
  setInflight,
  saveBufferToTemp,
  mapPool,
} = require('./invoiceCache');
const { log, logOk, logWarn, logErr } = require('./log');
const { isOutgoingClientInvoiceName } = require('./invoiceFilters');

const CLOSE_SEL =
  '.side-panel-label-icon-close, .side-panel-close, [class*="side-panel"] .ui-icon-btn-close, button[title="Закрыть"]';

/** Клики download на одной page нельзя параллелить — ждём очереди. */
let clickDownloadChain = Promise.resolve();
function withClickDownloadLock(fn) {
  const run = clickDownloadChain.then(fn, fn);
  clickDownloadChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function dlTimeout(panel = false) {
  if (panel) return Number(config.panelDownloadTimeoutMs) || (process.platform === 'win32' ? 12000 : 15000);
  return Number(config.downloadTimeoutMs) || (process.platform === 'win32' ? 15000 : 20000);
}

function absoluteHref(page, href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, page.url()).href;
  } catch {
    return raw;
  }
}

function fetchConcurrency() {
  return Math.max(1, Number(config.invoiceFetchConcurrency) || (process.platform === 'win32' ? 2 : 3));
}

function cacheEnabled() {
  return config.cacheInvoiceFiles !== false;
}

function nameFromContentDisposition(header) {
  const raw = String(header || '');
  const m =
    /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(raw);
  if (!m) return '';
  try {
    return decodeURIComponent((m[1] || m[2] || m[3] || '').trim());
  } catch {
    return (m[1] || m[2] || m[3] || '').trim();
  }
}

async function parseFile(filePath, parseOpts) {
  return extractAmountFromInvoiceFile(filePath, parseOpts);
}

/** Скачать по href через cookies сессии (без клика) и положить в кэш файлов. */
async function fetchFileByRequest(page, href, suggestedName) {
  const key = normalizeHref(href);
  if (!key) return null;

  if (cacheEnabled()) {
    const cached = getCachedFile(href);
    if (cached) return cached;
    const pending = getInflight(href);
    if (pending) return pending;
  }

  const job = (async () => {
    const response = await page.request.get(href, {
      timeout: dlTimeout(),
      failOnStatusCode: false,
      maxRedirects: 10,
    });
    if (!response.ok()) {
      throw new Error(`HTTP ${response.status()}`);
    }
    const buffer = Buffer.from(await response.body());
    // HTML вместо файла — логин/ошибка
    const ctype = String(response.headers()['content-type'] || '').toLowerCase();
    if (ctype.includes('text/html') && buffer.length < 200_000) {
      const head = buffer.slice(0, 200).toString('utf8');
      if (/<html|<\!doctype/i.test(head)) throw new Error('ответ HTML, не файл');
    }
    const fileName =
      nameFromContentDisposition(response.headers()['content-disposition']) ||
      suggestedName ||
      'invoice.bin';
    const entry = saveBufferToTemp(buffer, fileName);
    if (cacheEnabled()) setCachedFile(href, entry);
    return entry;
  })();

  return cacheEnabled() ? setInflight(href, job) : job;
}

async function downloadClickToFile(page, clickFn, suggestedName, timeoutMs) {
  return withClickDownloadLock(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-inv-'));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: timeoutMs }),
      clickFn(),
    ]);
    const fileName = download.suggestedFilename() || suggestedName || 'invoice.bin';
    const filePath = path.join(tmpDir, fileName);
    await download.saveAs(filePath);
    return { filePath, fileName: path.basename(filePath) };
  });
}

/**
 * Получить сумму счёта по href: кэш суммы → кэш файла → request → клик.
 * Счёт всегда разбираем файлом (не текстом ленты).
 */
async function amountFromHref(page, dealFrame, href, suggestedName, parseOpts = {}) {
  if (!href) return null;
  const fullHref = absoluteHref(page, href);
  const prefers = parseOpts.preferAmounts || [];

  if (cacheEnabled()) {
    const hit = getCachedAmount(fullHref, prefers);
    if (hit !== undefined) {
      log(`  кэш суммы «${suggestedName || normalizeHref(fullHref).slice(-40)}» → ${hit}`);
      return hit;
    }
  }

  let entry = cacheEnabled() ? getCachedFile(fullHref) : null;
  if (!entry) {
    try {
      entry = await fetchFileByRequest(page, fullHref, suggestedName);
      logOk(`  скачан (request): ${entry.filePath}`);
    } catch (err) {
      logWarn(`  request «${suggestedName || ''}»: ${err.message || err} — клик`);
      try {
        const ctx = dealFrame || page;
        entry = await downloadClickToFile(
          page,
          () =>
            ctx
              .evaluate((url) => {
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                document.body.appendChild(a);
                a.click();
                a.remove();
              }, fullHref)
              .catch(() =>
                ctx.locator(`a[href="${href}"], a[href="${fullHref}"]`).first().click({ timeout: 2000 })
              ),
          suggestedName,
          dlTimeout()
        );
        if (cacheEnabled()) setCachedFile(fullHref, entry);
        logOk(`  скачан (click): ${entry.filePath}`);
      } catch (err2) {
        logWarn(`  downloadByHref: ${err2.message || err2}`);
        if (cacheEnabled()) setCachedAmount(fullHref, prefers, null);
        return null;
      }
    }
  } else {
    log(`  кэш файла «${entry.fileName}»`);
  }

  const amount = await parseFile(entry.filePath, parseOpts);
  if (cacheEnabled()) setCachedAmount(fullHref, prefers, amount);
  return amount;
}

async function amountFromFileNameClick(page, dealFrame, fileName, parseOpts = {}) {
  const hint = fileName || 'Счет';
  try {
    const link = dealFrame.locator(`a:has-text("${hint}")`).first();
    if (!(await link.isVisible({ timeout: 500 }).catch(() => false))) return null;
    const href = (await link.getAttribute('href').catch(() => '')) || '';
    if (href) return amountFromHref(page, dealFrame, href, hint, parseOpts);

    const entry = await downloadClickToFile(
      page,
      () => link.click({ timeout: 2000 }),
      hint,
      dlTimeout()
    );
    logOk(`  скачан: ${entry.filePath}`);
    return parseFile(entry.filePath, parseOpts);
  } catch (err) {
    logWarn(`  download/parse: ${err.message || err}`);
    return null;
  }
}

/** Разобрать файлы счетов поставщика (параллельно по href). */
async function downloadFilesFromTimeline(page, dealFrame, files, parseOpts) {
  const list = (files || []).filter((f) => !isOutgoingClientInvoiceName(f.fileName));
  const results = await mapPool(list, fetchConcurrency(), async (file) => {
    const label = file.fileName || (file.fileHref || '').slice(0, 40);
    log(`  счёт «${label}»...`);
    let amount = null;
    if (file.fileHref) {
      amount = await amountFromHref(page, dealFrame, file.fileHref, file.fileName, parseOpts);
    }
    if (amount === null && file.fileName) {
      amount = await amountFromFileNameClick(page, dealFrame, file.fileName, parseOpts);
    }
    if (amount === null) logWarn(`  не прочитана сумма: «${label}»`);
    return amount !== null ? { amount, fileName: file.fileName || '' } : null;
  });
  return results.filter(Boolean);
}

function isTaskFrame(frame) {
  try {
    const u = frame.url() || '';
    return /\/tasks\/task\/view\//i.test(u) || (/task/i.test(u) && /IFRAME=Y|SIDE_SLIDER/i.test(u));
  } catch {
    return false;
  }
}

/**
 * Ссылки на файлы ТОЛЬКО из открытой задачи (не из ленты сделки).
 * Иначе в сверку попадают исходящие счета заказчику.
 */
/** Собрать file-ссылки из одного browser context (frame/page). */
async function extractFileLinksFromContext(ctx) {
  try {
    return await ctx.evaluate(() => {
      const re = /\.(xls|xlsx|pdf|docx?|rtf|txt)$/i;
      const out = [];
      for (const a of document.querySelectorAll('a')) {
        const text = (
          a.textContent ||
          a.getAttribute('title') ||
          a.getAttribute('data-title') ||
          a.getAttribute('download') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        const href = a.href || '';
        if (
          !(
            re.test(text) ||
            re.test(href) ||
            /счет|счёт|проформа|invoice|schet/i.test(text) ||
            href.includes('crm_show_file.php') ||
            href.includes('disk/uf.php') ||
            href.includes('/disk/downloadFile/')
          )
        ) {
          continue;
        }
        out.push({ text, href });
      }
      return out;
    });
  } catch {
    return [];
  }
}

/**
 * Ссылки на файлы ТОЛЬКО из открытой задачи (не из ленты сделки).
 * Иначе в сверку попадают исходящие счета заказчику.
 */
async function collectTaskFileLinks(page) {
  const targets = [];
  const seen = new Set();
  const push = (text, href) => {
    if (isOutgoingClientInvoiceName(text)) return;
    const key = href || text;
    if (!key || seen.has(key)) return;
    seen.add(key);
    targets.push({ fileName: text || '', fileHref: href || '' });
  };

  const frames = page.frames().filter(isTaskFrame);
  if (frames.length) {
    for (const ctx of frames) {
      for (const { text, href } of await extractFileLinksFromContext(ctx)) push(text, href);
    }
    return targets;
  }

  // URL задачи ещё не в frames — только DOM side-panel задачи
  try {
    const items = await page.evaluate(() => {
      const roots = Array.from(
        document.querySelectorAll(
          '.side-panel-content-container, .side-panel-content, .task-detail, [class*="task-detail"]'
        )
      );
      if (!roots.length) return [];
      const re = /\.(xls|xlsx|pdf|docx?|rtf|txt)$/i;
      const out = [];
      for (const root of roots) {
        for (const a of root.querySelectorAll('a')) {
          const text = (
            a.textContent ||
            a.getAttribute('title') ||
            a.getAttribute('data-title') ||
            a.getAttribute('download') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();
          const href = a.href || '';
          if (
            re.test(text) ||
            re.test(href) ||
            /счет|счёт|проформа|invoice|schet/i.test(text) ||
            href.includes('crm_show_file.php') ||
            href.includes('disk/uf.php') ||
            href.includes('/disk/downloadFile/')
          ) {
            out.push({ text, href });
          }
        }
      }
      return out;
    });
    for (const { text, href } of items || []) push(text, href);
  } catch {
    // ignore
  }
  return targets;
}

async function waitTaskPanel(page) {
  await settleAfterAction(
    async () => page.frames().some((f) => /IFRAME=Y|SIDE_SLIDER|\/tasks\//i.test(f.url())),
    { minMs: config.uiSettleMs || 200, maxMs: config.uiSettleTimeoutMs || 3000 }
  );
}

async function openTask(page, dealFrame, task) {
  const contexts = [dealFrame, page].filter(Boolean);
  const tryClick = async (locator, visibleMs, clickMs = 3000) => {
    if (!(await locator.isVisible({ timeout: visibleMs }).catch(() => false))) return false;
    await locator.click({ timeout: clickMs, force: true }).catch(() => locator.click({ timeout: clickMs }));
    await waitTaskPanel(page);
    return true;
  };

  try {
    for (const ctx of contexts) {
      if (task.href) {
        if (await tryClick(ctx.locator(`a[href="${task.href}"]`).first(), 800)) return true;
        const idMatch = String(task.href).match(/\/tasks\/task\/view\/(\d+)/);
        if (idMatch && (await tryClick(ctx.locator(`a[href*="/tasks/task/view/${idMatch[1]}"]`).first(), 500))) {
          return true;
        }
      }
      if (task.title) {
        if (
          await tryClick(
            ctx.locator(`a[href*="/tasks/task/view/"]`).filter({ hasText: task.title }).first(),
            500
          )
        ) {
          return true;
        }
        if (await tryClick(ctx.locator(`a:has-text("${task.title}")`).first(), 500)) return true;
      }
      // без общего «Открыть» — можно кликнуть чужую карточку в ленте
    }
  } catch (err) {
    logWarn(`  openTask: ${err.message || err}`);
  }
  return false;
}

async function closeSidePanel(page) {
  const maxMs = Number(config.sidePanelCloseTimeoutMs) || 2500;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const close = page.locator(CLOSE_SEL).first();
      if (await close.isVisible({ timeout: 300 }).catch(() => false)) {
        await close.click({ timeout: 800 }).catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      const gone = await waitUntil(
        async () =>
          !page.frames().some((f) => /\/tasks\/task\/view\/|IFRAME=Y.*task/i.test(f.url() || '')),
        { timeoutMs: Math.min(900, maxMs), intervalMs: 80 }
      );
      if (gone) {
        await settleAfterAction(null, {
          minMs: Math.min(120, config.uiSettleMs || 200),
          maxMs: Math.min(200, config.uiSettleMs || 200),
        });
        return;
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Все счета поставщика из задачи оплаты → [{ amount, fileName }].
 * Только файлы задачи; исходящие счета заказчику отбрасываем.
 */
async function extractAllSupplierInvoiceAmounts(page, dealFrame, task, preferAmounts = []) {
  const parseOpts = { preferAmounts };
  const fromTimeline = (
    Array.isArray(task.files) && task.files.length
      ? task.files
      : task.fileHref || task.fileName
        ? [{ fileName: task.fileName || '', fileHref: task.fileHref || '' }]
        : []
  ).filter((f) => !isOutgoingClientInvoiceName(f.fileName));

  if (!config.downloadSupplierInvoices) {
    logWarn('  скачивание счетов выключено — без сумм из файлов сверка невозможна');
    return [];
  }

  const byKey = new Map();
  const addFile = (f) => {
    const key = f.fileHref || f.fileName;
    if (!key || byKey.has(key)) return false;
    byKey.set(key, f);
    return true;
  };
  for (const f of fromTimeline) addFile(f);

  let results = await downloadFilesFromTimeline(page, dealFrame, [...byKey.values()], parseOpts);
  log(`  из ленты: файлов ${byKey.size}, сумм ${results.length}`);

  // в ленте часто не все вложения — открываем задачу и добираем
  if (await openTask(page, dealFrame, task)) {
    const need = Math.max(byKey.size, 1);
    let prev = -1;
    let stable = 0;
    await waitUntil(
      async () => {
        const n = (await collectTaskFileLinks(page)).length;
        if (n === prev && n >= need) stable += 1;
        else stable = 0;
        prev = n;
        return stable >= 2 || n > need;
      },
      { timeoutMs: 5000, intervalMs: 200 }
    );

    const taskFiles = await collectTaskFileLinks(page);
    const extra = [];
    for (const f of taskFiles) {
      if (addFile(f)) extra.push(f);
    }
    if (extra.length) {
      log(`  в задаче ещё вложений: ${extra.length} (всего ${byKey.size})`);
      results = results.concat(await downloadFilesFromTimeline(page, null, extra, parseOpts));
    } else {
      log(`  в задаче новых вложений нет (всего ${byKey.size})`);
    }
    await closeSidePanel(page);
  } else {
    logErr('  задачу открыть не удалось — сверка только по файлам из ленты');
  }

  return dedupeTaskAmounts(results);
}

function invoiceStem(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\.(pdf|xlsx?|docx?|csv)$/i, '')
    .replace(/\(\d+\)$/g, '')
    .replace(/[\s_\-]+/g, '');
}

/**
 * Дедуп копий одного счёта (pdf+xls).
 * Два разных файла с одной суммой — оба остаются.
 */
function dedupeTaskAmounts(items) {
  const out = [];
  const groups = new Map(); // amountKey -> stems[]
  for (const item of items || []) {
    if (!item || item.amount === null || item.amount === undefined) continue;
    const amtKey = String(Math.round(Number(item.amount) * 100) / 100);
    const stem = invoiceStem(item.fileName);
    const stems = groups.get(amtKey) || [];
    const isTwin = stems.some(
      (s) => !stem || !s || s === stem || (s.length >= 6 && stem.includes(s)) || (stem.length >= 6 && s.includes(stem))
    );
    if (isTwin) continue;
    stems.push(stem || `anon${stems.length}`);
    groups.set(amtKey, stems);
    out.push(item);
  }
  return out;
}

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
        // новый UI задач: description-preview / collapsible-text / ui-typography
        const sels = [
          '[data-testid="tasks-description-preview"]',
          '[data-testid="tasks-entity-collapsible-text"]',
          '.tasks-full-card-field-container [data-testid="tasks-entity-collapsible-text"]',
          '.tasks-card-entity-collapsible-text',
          '.ui-typography-container',
          '.task-detail-description',
          '.task-detail-description-text',
          '[class*="task-detail-description"]',
          '.tasks-frame-view-description',
          '[data-bx-id*="description"]',
          '.task-detail-content',
          '.ui-editor-content-block',
          '.tasks-task-view-description',
          '.side-panel-content-container .task-detail',
        ].join(', ');
        for (const el of document.querySelectorAll(sels)) {
          push(el.innerText || el.textContent || '');
        }
        // абзацы описания по отдельности — надёжнее для «Цена:» / «3 000»
        for (const p of document.querySelectorAll(
          '[data-testid="tasks-description-preview"] .ui-typography-paragraph, [data-testid="tasks-entity-collapsible-text"] p, .ui-typography-container p'
        )) {
          push(p.innerText || p.textContent || '');
        }
        if (!out.length) {
          const panel =
            document.querySelector(
              '[data-testid="tasks-description-preview"], .side-panel-content-container, .side-panel-content, .task-detail'
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

  const uniq = [];
  const seen = new Set();
  // сначала более длинные куски (полное описание), потом короткие абзацы
  for (const c of chunks.sort((a, b) => b.length - a.length)) {
    const key = c.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  return uniq;
}

async function extractWarehouseAmount(page, dealFrame, task, preferAmounts = []) {
  const prefers = (preferAmounts || []).filter((n) => Number.isFinite(n));
  const maxPrefer = prefers.length ? Math.max(...prefers) : null;
  const plausibleWriteOff = (amount) =>
    amount !== null && (maxPrefer === null || amount >= maxPrefer * 0.5);

  const fromCard = extractWriteOffAmountFromText(
    task.sectionText || task.fingerprint || '',
    preferAmounts
  );
  // превью часто содержит только эквайринг 87 — не верим, если есть крупная графа
  if (plausibleWriteOff(fromCard)) {
    log(`  сумма списания из ленты: ${fromCard}`);
    return fromCard;
  }
  if (fromCard !== null) {
    logWarn(`  в ленте только ${fromCard}, открываю задачу (в графах до ${maxPrefer})`);
  }

  let found = null;
  const openTimeout = Number(config.warehouseOpenTimeoutMs) || 8000;
  const opened = await openTask(page, dealFrame, task);
  if (opened) {
    await waitUntil(
      async () => {
        const chunks = await collectTaskBodyTexts(page);
        if (!chunks.length) return false;
        // сначала цельный текст (цена и «1 шт» могут быть в разных абзацах)
        const joined = chunks.join('\n');
        const fromJoined = extractWriteOffAmountFromText(joined, preferAmounts);
        if (plausibleWriteOff(fromJoined)) {
          found = fromJoined;
          log(`  сумма списания из текста задачи: ${fromJoined}`);
          return true;
        }
        for (const chunk of chunks) {
          const amount = extractWriteOffAmountFromText(chunk, preferAmounts);
          if (!plausibleWriteOff(amount)) continue;
          found = amount;
          log(`  сумма списания из текста задачи: ${amount}`);
          return true;
        }
        // ждём появления блока описания нового UI
        return false;
      },
      { timeoutMs: openTimeout, intervalMs: 250 }
    );
    await closeSidePanel(page);
  } else {
    logWarn('  задачу списания не открыл — в ленте суммы тоже нет');
  }
  return found;
}

module.exports = {
  extractAllSupplierInvoiceAmounts,
  extractWarehouseAmount,
  closeSidePanel,
};
