/**
 * Чтение карточки сделки Битрикс24 по реальной вёрстке (2024–2026 UI).
 *
 * Важно: контент живёт в iframe.side-panel-iframe
 *   src=".../crm/deal/details/ID/?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER"
 *
 * Поля:
 *   .ui-entity-editor-content-block
 *     .ui-entity-editor-block-title-text  → метка
 *     .ui-entity-editor-content-block / .field-item → значение
 *
 * Лента:
 *   .crm-entity-stream-section / .crm-timeline__card-wrapper
 */

const config = require('../config');
const { parseMoney, waitUntil, settleAfterAction } = require('./utils');
const { logStep, logOk, logWarn } = require('./log');

const CLOSE_SEL =
  '.side-panel-label-icon-close, .side-panel-close, [class*="side-panel"] .ui-icon-btn-close, button[title="Закрыть"]';

function extractDealId(url) {
  const m = String(url || '').match(/\/crm\/deal\/details\/(\d+)/);
  return m ? m[1] : '';
}

function frameMatchesDeal(frame, dealId) {
  if (!dealId) return /IFRAME=Y|SIDE_SLIDER|\/crm\/deal\/details\//i.test(frame.url());
  return new RegExp(`/crm/deal/details/${dealId}\\b`).test(frame.url());
}

/** Есть ли side-panel iframe этой сделки. */
function dealSliderFrames(page, dealId) {
  return page.frames().filter((f) => {
    if (!frameMatchesDeal(f, dealId)) return false;
    return /IFRAME=Y|SIDE_SLIDER/i.test(f.url()) || f !== page.mainFrame();
  });
}

/**
 * Закрыть карточку и дождаться исчезновения её iframe.
 * Без этого каждая вторая сделка читается из «пустого»/старого slider.
 */
async function closeDealPanel(page, dealId) {
  if (!dealId || page.isClosed()) return;

  const closeTimeout = config.sidePanelCloseTimeoutMs || (process.platform === 'win32' ? 2500 : 3500);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const close = page.locator(CLOSE_SEL).first();
      if (await close.isVisible({ timeout: 200 }).catch(() => false)) {
        await close.click({ timeout: 1000 }).catch(() => {});
      } else {
        await page.keyboard.press('Escape');
      }
    } catch {
      return;
    }

    const gone = await waitUntil(
      async () => dealSliderFrames(page, dealId).length === 0,
      { timeoutMs: Math.min(1200, closeTimeout), intervalMs: 80 }
    );
    if (gone) {
      logStep('iframe', `закрыт slider #${dealId}`);
      // короткая пауза — iframe успевает отцепиться до следующей сделки
      await settleAfterAction(null, {
        minMs: Math.min(150, config.uiSettleMs || 200),
        maxMs: Math.min(250, config.uiSettleMs || 200),
      });
      return;
    }
  }
  logWarn(`не удалось дождаться закрытия slider #${dealId}`);
}

/** Клик по ссылке сделки в отчёте — без полной перезагрузки страницы. */
async function tryOpenDealByClick(page, dealId) {
  if (!dealId || page.isClosed()) return false;
  try {
    const link = page.locator(`a[href*="/crm/deal/details/${dealId}"]`).first();
    if (!(await link.isVisible({ timeout: 400 }).catch(() => false))) return false;
    logStep('iframe', `клик по ссылке #${dealId} в отчёте`);
    await link.click({ timeout: 3000 });
    await settleAfterAction(
      async () => dealSliderFrames(page, dealId).length > 0,
      { minMs: config.uiSettleMs || 200, maxMs: config.uiSettleTimeoutMs || 3000 }
    );
    return true;
  } catch (err) {
    logWarn(`клик по сделке #${dealId}: ${err.message || err}`);
    return false;
  }
}

/**
 * Открыть карточку нужной сделки и вернуть её iframe.
 * previousDealId — закрыть прошлую ДО открытия новой.
 * Сначала клик в отчёте (быстрее на Windows), иначе goto.
 */
async function openDealCard(page, dealUrl, { previousDealId = '', timeoutMs } = {}) {
  const dealId = extractDealId(dealUrl);
  const openTimeout = timeoutMs || config.dealOpenTimeoutMs || 20000;
  logStep('iframe', `открываю #${dealId || '?'}`);

  if (previousDealId) {
    await closeDealPanel(page, previousDealId);
  } else {
    // на всякий случай сбросить висящий slider
    try {
      await page.keyboard.press('Escape');
    } catch {
      // ignore
    }
    await waitUntil(
      async () => !page.frames().some((f) => /IFRAME=Y|SIDE_SLIDER/i.test(f.url()) && f !== page.mainFrame()),
      { timeoutMs: 1200, intervalMs: 80 }
    );
  }

  let openedByClick = false;
  if (config.openDealByClick !== false) {
    openedByClick = await tryOpenDealByClick(page, dealId);
  }

  if (!openedByClick) {
    try {
      await page.goto(dealUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      logWarn(`goto: ${err.message || err}`);
    }
  }

  const frame = await resolveDealFrame(page, dealUrl, openTimeout);
  if (!frame) {
    // fallback: полный переход, если клик/первый goto не подняли slider
    logWarn('iframe не появился — повторный переход');
    try {
      await page.goto(dealUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      // ignore
    }
    const again = await resolveDealFrame(page, dealUrl, openTimeout);
    if (again) return again;
    throw new Error(`Не открылся iframe сделки #${dealId}`);
  }
  return frame;
}

/** Ждём iframe именно этой сделки с редактором полей. Не подменяем на main наугад. */
async function resolveDealFrame(page, dealUrl, timeoutMs = 20000) {
  const dealId = extractDealId(dealUrl);
  let found = null;

  const ok = await waitUntil(
    async () => {
      if (page.isClosed()) throw new Error('браузер закрыт');

      const frames = dealSliderFrames(page, dealId);
      for (const frame of frames) {
        try {
          const ready = await frame.evaluate(
            () => document.querySelectorAll('.ui-entity-editor-block-title-text').length >= 3
          );
          if (ready) {
            found = frame;
            return true;
          }
        } catch {
          // loading / detached
        }
      }

      // редкий режим: карточка в main без slider
      if (frameMatchesDeal({ url: () => page.url() }, dealId) && !frames.length) {
        const mainOk = await page
          .evaluate(() => document.querySelectorAll('.ui-entity-editor-block-title-text').length >= 3)
          .catch(() => false);
        if (mainOk) {
          found = page.mainFrame();
          return true;
        }
      }
      return false;
    },
    { timeoutMs, intervalMs: 150 }
  );

  if (ok && found) {
    logOk(`iframe: ${found.url().slice(0, 100)}`);
    return found;
  }
  return null;
}

async function expandEditorSections(frame) {
  await frame
    .evaluate(() => {
      const headers = Array.from(
        document.querySelectorAll(
          '.ui-entity-editor-section-header, .ui-entity-editor-section-title, [class*="entity-editor-section"]'
        )
      );
      for (const h of headers) {
        const t = (h.textContent || '').toLowerCase();
        if (!/о сделке|товары|маржинальн|финанс/i.test(t)) continue;
        try {
          h.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {
          // ignore
        }
        const section = h.closest('.ui-entity-editor-section, [class*="entity-editor-section"]') || h.parentElement;
        const collapsed =
          section?.classList?.contains('ui-entity-editor-section-collapsed') ||
          section?.classList?.contains('--collapsed') ||
          h.getAttribute('aria-expanded') === 'false';
        if (collapsed || /о сделке|товары/i.test(t)) {
          try {
            h.click();
          } catch {
            // ignore
          }
        }
      }

      // проскроллить к первому «Поставщик N», чтобы ленивый блок дорисовался
      const supplierTitle = Array.from(
        document.querySelectorAll('.ui-entity-editor-block-title-text')
      ).find((el) => /^поставщик\s*\d+/i.test((el.textContent || '').trim()));
      if (supplierTitle) {
        try {
          supplierTitle.scrollIntoView({ block: 'center' });
        } catch {
          // ignore
        }
      }
    })
    .catch(() => {});
}

/**
 * Ждём месяц (значение или явный «не заполнено»).
 * «Не заполнено» принимаем только если оно не меняется несколько опросов подряд.
 */
async function waitForDealFields(frame, timeoutMs = 20000) {
  let lastMonth = null;
  let stable = 0;

  return waitUntil(
    async () => {
      await expandEditorSections(frame);
      const month = await frame.evaluate(() => {
        const titles = Array.from(document.querySelectorAll('.ui-entity-editor-block-title-text'));
        const titleEl = titles.find((el) => /месяц завершения/i.test(el.textContent || ''));
        if (!titleEl) return null;

        let node = titleEl;
        for (let up = 0; up < 6 && node; up++) {
          node = node.parentElement;
          if (!node) break;
          if (node.querySelector('.ui-ctl-wait, .ui-entity-editor-loading, .bx-loader')) return '';
          const item = node.querySelector('.field-item');
          if (item && !item.contains(titleEl)) {
            const v = (item.textContent || '').trim();
            if (v) return v;
          }
          for (const el of node.querySelectorAll('[aria-label]')) {
            const aria = el.getAttribute('aria-label') || '';
            const m = aria.match(/^Изменить:.*?,\s*(.+)$/i);
            if (m) return m[1].trim();
          }
        }
        return '';
      });

      if (month === null) return false; // заголовка ещё нет
      if (!month) return false; // пусто — грузится

      // есть реальное значение месяца (не плейсхолдер)
      if (!/^не заполнено$|^указать|^выбрать/i.test(month)) return true;

      // явная пустота — только после стабилизации
      if (month === lastMonth) stable += 1;
      else {
        lastMonth = month;
        stable = 0;
      }
      return stable >= 3;
    },
    { timeoutMs, intervalMs: 150, label: 'deal-fields' }
  );
}

/**
 * Главное: не идём дальше, пока не прочитали хотя бы одну сумму
 * из граф Поставщик / доп.расходы / доставка.
 * «Не заполнено» само по себе НЕ считается успехом — ждём цифры.
 */
async function waitForCostAmounts(frame, labelHints, timeoutMs = 30000) {
  return waitUntil(
    async () => {
      await expandEditorSections(frame);
      const costs = await readCostFieldsFromFrame(frame, labelHints);
      return costs.length > 0;
    },
    { timeoutMs, intervalMs: 200, label: 'cost-amounts' }
  );
}

/** Ждём ленту: секции появились (не по таймеру). */
async function waitForTimelineReady(frame, timeoutMs = 12000) {
  return waitUntil(
    async () => {
      const state = await frame.evaluate(() => {
        const n = document.querySelectorAll(
          '.crm-entity-stream-section, .crm-timeline__card-wrapper'
        ).length;
        const t = (document.body?.innerText || '').toLowerCase();
        const markers =
          t.includes('счет заказчику') ||
          t.includes('счёт заказчику') ||
          t.includes('предоплата') ||
          t.includes('постоплата') ||
          t.includes('списание со склада') ||
          t.includes('задача');
        return { n, markers };
      });
      if (state.markers) return true;
      if (state.n >= 2) {
        // есть секции, но маркеров ещё нет — подскроллим и проверим снова на следующем круге
        await scrollTimelineInFrame(frame, 1);
      }
      return false;
    },
    { timeoutMs, intervalMs: 200, label: 'timeline' }
  );
}

async function readFieldsFromFrame(frame) {
  return frame.evaluate(() => {
    const clean = (value, label) => {
      let v = String(value || '').replace(/\s+/g, ' ').trim();
      if (!v) return '';
      if (/^не заполнено$/i.test(v) || /^указать/i.test(v) || /^выбрать/i.test(v)) return '';
      if (label) {
        const re = new RegExp(
          '^' + String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-]?\\s*',
          'i'
        );
        v = v.replace(re, '').trim();
      }
      if (/^не заполнено$/i.test(v)) return '';
      return v;
    };

    const readNearTitle = (titleEl) => {
      let node = titleEl;
      for (let up = 0; up < 6 && node; up++) {
        node = node.parentElement;
        if (!node) break;

        const item = node.querySelector('.field-item');
        if (item && !item.contains(titleEl)) {
          const v = (item.textContent || '').trim();
          if (v) return v;
        }

        for (const el of node.querySelectorAll('[aria-label]')) {
          const aria = el.getAttribute('aria-label') || '';
          if (/^Изменить:|^Change:/i.test(aria)) {
            const m = aria.match(/,\s*(.+)$/);
            if (m) return m[1].trim();
          }
        }

        const input = node.querySelector('input:not([type="hidden"]), textarea');
        if (input && (input.value || '').trim()) return input.value.trim();
      }

      const titleWrap = titleEl.closest('.ui-entity-editor-block-title') || titleEl.parentElement;
      const sib = titleWrap?.nextElementSibling;
      if (sib) return (sib.textContent || '').replace(/\s+/g, ' ').trim();
      return '';
    };

    const out = {};
    const titles = Array.from(document.querySelectorAll('.ui-entity-editor-block-title-text'));
    for (const titleEl of titles) {
      const label = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      const value = clean(readNearTitle(titleEl), label);
      if (value || out[label] === undefined) out[label] = value;
    }

    for (const el of document.querySelectorAll('[aria-label^="Изменить:"], [aria-label^="Change:"]')) {
      const aria = el.getAttribute('aria-label') || '';
      const m = aria.match(/^Изменить:\s*(.+?),\s*(.+)$/i) || aria.match(/^Change:\s*(.+?),\s*(.+)$/i);
      if (!m) continue;
      const label = m[1].trim();
      const value = clean(m[2], label);
      if (value && !out[label]) out[label] = value;
    }

    return out;
  });
}

async function readFieldByTextFallback(frame, label) {
  return frame.evaluate((rawLabel) => {
    const wanted = String(rawLabel).replace(/\s+/g, ' ').trim().toLowerCase();

    // aria-label: «Изменить: Месяц завершения сделки, 2026 октябрь»
    for (const el of document.querySelectorAll('[aria-label]')) {
      const aria = el.getAttribute('aria-label') || '';
      const low = aria.toLowerCase();
      if (!low.includes(wanted)) continue;
      const m = aria.match(/,\s*(.+)$/);
      if (m) {
        const v = m[1].trim();
        if (v && !/^не заполнено$/i.test(v)) return v;
      }
    }

    const lines = (document.body?.innerText || '')
      .split(/\r?\n/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase().replace(/:$/, '');
      if (line === wanted || line.endsWith(wanted)) {
        // «Месяц завершения сделки 2026 октябрь» в одной строке
        if (lines[i].length > rawLabel.length + 2) {
          const same = lines[i].slice(lines[i].toLowerCase().indexOf(wanted) + wanted.length).trim();
          if (same && !/^не заполнено$/i.test(same)) return same.replace(/^[:\-]\s*/, '');
        }
        const next = lines[i + 1] || '';
        if (!next) return '';
        if (/^не заполнено$/i.test(next) || /^указать/i.test(next) || /^выбрать/i.test(next)) return '';
        // не берём следующий заголовок поля
        if (next.length < 80) return next;
      }
    }
    return '';
  }, label);
}

/**
 * Заполненные суммы из граф затрат (поставщики, доп.расходы, доставка…).
 * Пустые / «не заполнено» / 0 пропускаем.
 */
/** optsOrFields: уже прочитанная карта полей — не дергаем DOM второй раз. */
async function readCostFieldsFromFrame(frame, labelHints = [], optsOrFields) {
  const fields =
    optsOrFields && typeof optsOrFields === 'object' && !Array.isArray(optsOrFields)
      ? optsOrFields
      : await readFieldsFromFrame(frame);
  const hints = (labelHints || []).map((h) => String(h).toLowerCase());
  const list = [];

  for (const [label, valueText] of Object.entries(fields)) {
    const low = label.toLowerCase();
    if (!hints.some((h) => low.includes(h) || new RegExp(`^${h}\\s*\\d+$`, 'i').test(label))) continue;
    if (!valueText || /не заполнено|указать|выбрать/i.test(valueText)) continue;
    const amount = parseMoney(valueText);
    if (amount === null || Math.abs(amount) < 0.0001) continue;
    list.push({ label, valueText, amount });
  }

  list.sort((a, b) => a.amount - b.amount || a.label.localeCompare(b.label, 'ru'));
  return list;
}

async function findClientInvoiceInFrame(frame, dealName) {
  return frame.evaluate((name) => {
    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е');
    const wantedName = norm(name);

    const isFileLink = (a) => {
      const t = (a.textContent || '').trim();
      const href = a.href || '';
      const title = a.getAttribute('title') || '';
      const download = a.getAttribute('download') || '';
      const blob = `${t} ${title} ${download} ${href}`;
      return (
        /\.(pdf|docx?|xlsx?|xls|rtf)$/i.test(blob) ||
        /исходящ/i.test(blob) ||
        href.includes('disk/uf.php') ||
        href.includes('crm_show_file.php') ||
        href.includes('/disk/') ||
        href.includes('download') ||
        a.className?.toString?.().includes('disk') ||
        a.hasAttribute('data-object-id')
      );
    };

    const sections = Array.from(
      document.querySelectorAll('.crm-entity-stream-section, .crm-timeline__card-wrapper')
    );

    for (const section of sections) {
      const text = norm(section.innerText || '');
      if (!text.includes('счет заказчику') && !text.includes('счёт заказчику')) continue;

      const links = Array.from(section.querySelectorAll('a'));
      let fileLink =
        links.find((a) => isFileLink(a) && wantedName && norm(a.textContent || '').includes(wantedName)) ||
        links.find((a) => isFileLink(a) && /исходящ/i.test(a.textContent || a.getAttribute('title') || '')) ||
        links.find((a) => isFileLink(a));

      const fileName = (
        fileLink?.getAttribute('title') ||
        fileLink?.getAttribute('download') ||
        fileLink?.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      const okName = !wantedName || !fileName || norm(fileName).includes(wantedName);

      return {
        found: true,
        fileName,
        fileHref: fileLink?.href || '',
        nameMatches: okName,
        snippet: (section.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    }

    return { found: false, fileName: '', fileHref: '', nameMatches: false, snippet: '' };
  }, dealName);
}

async function findPaymentTasksInFrame(frame, hints, dealName, options = {}) {
  const requireDealName = options.requireDealName !== false;
  return frame.evaluate(
    ({ hints, dealName, requireDealName }) => {
      const norm = (s) =>
        String(s || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
          .replace(/ё/g, 'е');
      const hs = hints.map(norm).filter(Boolean);
      // более длинные хинты важнее («списание со склада» раньше «списание»)
      hs.sort((a, b) => b.length - a.length);
      const name = norm(dealName);
      const tasks = [];

      const sections = Array.from(
        document.querySelectorAll('.crm-entity-stream-section, .crm-timeline__card-wrapper')
      );

      for (const section of sections) {
        const text = (section.innerText || '').replace(/\s+/g, ' ').trim();
        const low = norm(text);
        if (!low.includes('задача') && !hs.some((h) => h.includes('списание') && low.includes(h))) {
          continue;
        }
        const matched = hs.find((h) => low.includes(h));
        if (!matched) continue;
        // пропускаем «Создана задача …» без карточки
        if (/^создана задача/i.test(text) && !/крайний срок|исполнитель|открыть/i.test(text)) continue;
        // для списания название сделки в карточке часто отсутствует
        if (requireDealName && name && !low.includes(name)) continue;

        const titleLink = Array.from(section.querySelectorAll('a')).find((a) => {
          const t = norm(a.textContent || '');
          return hs.some((h) => t.includes(h)) && (a.href || '').includes('/tasks/task/view/');
        }) || Array.from(section.querySelectorAll('a')).find((a) =>
          (a.href || '').includes('/tasks/task/view/')
        );

        const title =
          (titleLink?.textContent || '').replace(/\s+/g, ' ').trim() ||
          text.match(new RegExp(`(?:${hs.join('|')})[^\\n]*`, 'i'))?.[0] ||
          matched;

        const fileLinks = Array.from(section.querySelectorAll('a')).filter((a) => {
          const t = (a.textContent || '').trim();
          const href = a.href || '';
          return (
            /\.(pdf|docx?|xlsx?|xls)$/i.test(t) ||
            /счет|счёт|проформа|invoice/i.test(t) ||
            href.includes('crm_show_file.php') ||
            href.includes('disk/uf.php')
          );
        });

        const files = [];
        const seenHref = new Set();
        for (const a of fileLinks) {
          const href = a.href || '';
          const fileName = (a.textContent || '').replace(/\s+/g, ' ').trim();
          const key = href || fileName;
          if (!key || seenHref.has(key)) continue;
          // исходящий счёт заказчику в превью задачи не берём в сверку поставщиков
          // (логика совпадает с src/invoiceFilters.js — в frame.evaluate нет require)
          const low = fileName.toLowerCase().replace(/ё/g, 'е');
          if (
            low.includes('исходящ') ||
            /сч[её]т\s+на\s+оплату\s+№\s*ю\d{2}/i.test(low) ||
            /сч[её]т\s+на\s+оплату\s+№\s*(нал|qr)[-–]?\s*ю?/i.test(low)
          ) {
            continue;
          }
          seenHref.add(key);
          files.push({ fileName, fileHref: href });
        }

        tasks.push({
          title,
          href: titleLink?.href || '',
          fileName: files[0]?.fileName || '',
          fileHref: files[0]?.fileHref || '',
          files,
          hasOpen: /открыть/i.test(text),
          fingerprint: text.slice(0, 1200),
          sectionText: text,
        });
      }

      // одна задача — один элемент; вложения сливаем
      const map = new Map();
      for (const t of tasks) {
        const key = norm(t.title);
        if (!map.has(key)) {
          map.set(key, t);
          continue;
        }
        const existing = map.get(key);
        for (const f of t.files || []) {
          if (!existing.files.some((x) => (x.fileHref || x.fileName) === (f.fileHref || f.fileName))) {
            existing.files.push(f);
          }
        }
        if (!existing.fileHref && t.fileHref) {
          existing.fileHref = t.fileHref;
          existing.fileName = t.fileName;
        }
        if ((t.fingerprint || '').length > (existing.fingerprint || '').length) {
          existing.fingerprint = t.fingerprint;
        }
        if ((t.sectionText || '').length > (existing.sectionText || '').length) {
          existing.sectionText = t.sectionText;
        }
      }
      return Array.from(map.values());
    },
    { hints, dealName, requireDealName }
  );
}

/**
 * Тексты комментариев/записей ленты (не задачи).
 * Нужны для СДЭК и «3% за эквайринг».
 */
async function readTimelineComments(frame) {
  return frame.evaluate(() => {
    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е');

    const sections = Array.from(
      document.querySelectorAll('.crm-entity-stream-section, .crm-timeline__card-wrapper')
    );
    const out = [];

    for (const section of sections) {
      const text = (section.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 3) continue;
      const low = norm(text);

      // пропускаем чистые карточки задач оплаты/списания — их разбираем отдельно
      const isTaskCard =
        low.includes('задача') &&
        (low.includes('предоплата') ||
          low.includes('постоплата') ||
          low.includes('списание') ||
          /крайний срок|исполнитель/i.test(text));
      if (isTaskCard) continue;

      out.push(text);
    }

    // на всякий случай — весь текст ленты кусками по строкам с ключевыми словами
    const body = (document.body?.innerText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of body) {
      const low = norm(line);
      if (
        (low.includes('сдэк') ||
          low.includes('cdek') ||
          low.includes('сдек') ||
          low.includes('эквайринг') ||
          low.includes('эквайр') ||
          /3\s*%/.test(low)) &&
        !out.some((t) => norm(t).includes(low) || low.includes(norm(t).slice(0, 40)))
      ) {
        out.push(line);
      }
    }

    return out;
  });
}

async function scrollTimelineInFrame(frame, steps = 4) {
  await frame
    .evaluate(async (scrollSteps) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const stream =
        document.querySelector('.crm-entity-stream-container') ||
        document.querySelector('[class*="stream"]') ||
        document.scrollingElement;

      const hasMarkers = () => {
        const t = (document.body?.innerText || '').toLowerCase();
        return (
          t.includes('счет заказчику') ||
          t.includes('счёт заказчику') ||
          t.includes('предоплата') ||
          t.includes('постоплата') ||
          t.includes('списание')
        );
      };

      for (let i = 0; i < scrollSteps; i++) {
        if (stream) stream.scrollTop = (stream.scrollTop || 0) + 1200;
        window.scrollBy(0, 1200);
        await sleep(80);
        // если ключевые блоки уже видны — не крутим дальше
        if (i >= 1 && hasMarkers()) break;
      }
      const more = document.querySelector('.crm-entity-stream-section-load-more');
      if (more) more.click();
      await sleep(100);
      window.scrollTo(0, 0);
    }, steps)
    .catch(() => {});
}

async function dumpFrameDiagnostics(frame) {
  return frame.evaluate(() => {
    const text = document.body?.innerText || '';
    return {
      len: text.length,
      hasAbout: /о сделке/i.test(text),
      hasMonth: /месяц завершения/i.test(text),
      hasSupplier: /поставщик\s*\d/i.test(text),
      hasInvoice: /сч[её]т заказчику/i.test(text),
      hasPrepay: /предоплата/i.test(text),
      titleCount: document.querySelectorAll('.ui-entity-editor-block-title-text').length,
      streamCount: document.querySelectorAll('.crm-entity-stream-section').length,
    };
  });
}

module.exports = {
  extractDealId,
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
};
