#!/usr/bin/env node
/**
 * Проверка сделок из отчёта Битрикс24 через Playwright.
 *
 * Запуск:
 *   node check-deals.js
 *   VERBOSE=1 node check-deals.js   — подробные логи
 */

const { chromium } = require('playwright');
const config = require('./config');
const { ask, waitForEnter, sleep } = require('./src/utils');
const { waitForReportReady, collectDealLinks } = require('./src/report');
const { checkDeal } = require('./src/deal');
const { writeCsv, printSummary, printDealIssues } = require('./src/output');
const { info, log, logStep, logWarn, logErr } = require('./src/log');

async function main() {
  info('Проверка сделок Битрикс24 (только чтение, ничего не меняет)');
  info('Сборка: 2026-11-09d (СДЭК/эквайринг из комментариев + списание сумма/всего)');
  if (config.verbose) info('Подробные логи включены (config.verbose / VERBOSE=1)');

  const reportUrl = await ask('\nВставьте ссылку на отчёт и нажмите Enter:\n> ');
  if (!reportUrl || !/^https?:\/\//i.test(reportUrl)) {
    logErr('Нужна полная ссылка (http:// или https://)');
    process.exit(1);
  }

  info('Открываю браузер. Залогиньтесь и дождитесь отчёта (или нажмите Enter).');

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    logWarn('Страница логина/таймаут — это нормально, войдите вручную');
    log(String(err.message || err));
  }

  await Promise.race([
    waitForEnter('Enter = начать сейчас...\n'),
    waitForReportReady(page, config.reportWaitMs).catch(() => null),
  ]);

  if (!page.url().includes('/crm/reports/report/')) {
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  try {
    await waitForReportReady(page, Math.min(config.reportWaitMs, 60_000));
  } catch {
    logErr('Не вижу таблицу отчёта. Откройте отчёт со сделками и запустите снова.');
    await browser.close();
    process.exit(1);
  }

  const deals = await collectDealLinks(page);
  if (!deals.length) {
    logErr('В отчёте нет ссылок на сделки');
    await browser.close();
    process.exit(1);
  }

  info(`Найдено сделок: ${deals.length}\n`);

  const results = [];
  let previousDealId = '';
  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const prefix = `[${i + 1}/${deals.length}] #${deal.id} ${deal.title}`;

    if (page.isClosed()) {
      info('Браузер закрыт — останавливаюсь.');
      break;
    }

    try {
      const result = await checkDeal(page, deal, { previousDealId });
      previousDealId = deal.id;
      results.push(result);

      if (result.ok) {
        info(`${prefix} — OK`);
      } else {
        info(`${prefix} — нужно исправить:`);
        printDealIssues(result);
        info('');
      }
    } catch (err) {
      const msg = String(err.message || err);
      if (/closed|Target page|has been closed|browser has been closed/i.test(msg)) {
        info(`${prefix} — остановлено (браузер закрыт)`);
        break;
      }
      const problem = `Не удалось проверить: ${msg}`;
      const fix = 'Откройте сделку вручную; при повторе — VERBOSE=1 и пришлите лог';
      results.push({
        id: deal.id,
        title: deal.title,
        url: deal.url,
        ok: false,
        errors: [`${problem} → ${fix}`],
        issues: [{ problem, fix }],
        details: {},
      });
      info(`${prefix} — сбой`);
      info(`  Что не так: ${problem}`);
      info(`  Что сделать: ${fix}`);
      info('');
    }

    try {
      writeCsv(results);
    } catch (err) {
      logWarn(`Не удалось сохранить CSV: ${err.message || err}`);
    }

    await sleep(config.delayBetweenDealsMs);
  }

  printSummary(results);
  const file = writeCsv(results, { final: true });
  info(`Таблица: ${file}`);
  info('(откройте в Excel)\n');

  await waitForEnter('Готово. Enter — закрыть браузер...');
  await browser.close();
}

async function launchBrowser() {
  const fs = require('fs');
  const args = ['--disable-blink-features=AutomationControlled'];
  // на части Linux-систем без этого Chromium не стартует
  if (process.platform === 'linux') args.push('--no-sandbox');

  const options = {
    headless: false,
    args,
  };

  // опционально: свой Chrome/Chromium через переменную окружения
  const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (custom && fs.existsSync(custom)) {
    logStep('браузер', `custom: ${custom}`);
    try {
      return await chromium.launch({ ...options, executablePath: custom });
    } catch (err) {
      logWarn(`Не удалось запустить CHROME_PATH, пробую встроенный Playwright: ${err.message}`);
    }
  }

  try {
    return await chromium.launch(options);
  } catch (err) {
    logErr('Не удалось запустить браузер Playwright.');
    info('Выполните один раз: npx playwright install chromium');
    throw err;
  }
}

main().catch((err) => {
  logErr(`Критическая ошибка: ${err.message || err}`);
  if (config.verbose) console.error(err);
  process.exit(1);
});
