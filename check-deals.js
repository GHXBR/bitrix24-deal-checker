#!/usr/bin/env node
/**
 * Проверка сделок из отчёта Битрикс24 через Playwright.
 *
 * Запуск:
 *   node check-deals.js
 *   VERBOSE=1 node check-deals.js   — подробные логи
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const { ask, waitForEnter, sleep } = require('./src/utils');
const { waitForReportReady, collectDealLinks } = require('./src/report');
const { checkDeal } = require('./src/deal');
const { writeReport, openReport, printSummary, printDealIssues, formatComment } = require('./src/output');
const { info, log, logStep, logWarn, logErr } = require('./src/log');

function readReportUrlFromArgs() {
  const fromEnv = String(process.env.REPORT_URL || '').trim();
  if (fromEnv) return fromEnv;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--url=')) return arg.slice('--url='.length).trim();
    if (arg === '--url') continue;
  }
  const idx = process.argv.indexOf('--url');
  if (idx >= 0 && process.argv[idx + 1]) return String(process.argv[idx + 1]).trim();
  return '';
}

function isGuiMode() {
  return process.env.GUI_MODE === '1' || process.argv.includes('--gui');
}

async function main() {
  const guiMode = isGuiMode();
  info('Проверка сделок Битрикс24 (только чтение, ничего не меняет)');
  info('Сборка: 2026-11-11q (списание: новый UI описания; цена=сумма при 1 шт; суммы 3 000)');
  if (config.verbose) info('Подробные логи включены (config.verbose / VERBOSE=1)');

  let reportUrl = readReportUrlFromArgs();
  if (!reportUrl) {
    reportUrl = await ask('\nВставьте ссылку на отчёт и нажмите Enter:\n> ');
  }
  if (!reportUrl || !/^https?:\/\//i.test(reportUrl)) {
    logErr('Нужна полная ссылка (http:// или https://)');
    process.exit(1);
  }

  info(
    guiMode
      ? 'Открываю браузер. Залогиньтесь и дождитесь таблицы отчёта.'
      : 'Открываю браузер. Залогиньтесь и дождитесь отчёта (или нажмите Enter).'
  );

  const { context, close } = await launchBrowserContext();
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    logWarn('Страница логина/таймаут — это нормально, войдите вручную');
    log(String(err.message || err));
  }

  if (guiMode) {
    await waitForReportReady(page, config.reportWaitMs).catch(() => null);
  } else {
    await Promise.race([
      waitForEnter('Enter = начать сейчас...\n'),
      waitForReportReady(page, config.reportWaitMs).catch(() => null),
    ]);
  }

  if (!page.url().includes('/crm/reports/report/')) {
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  try {
    await waitForReportReady(page, Math.min(config.reportWaitMs, 60_000));
  } catch {
    logErr('Не вижу таблицу отчёта. Откройте отчёт со сделками и запустите снова.');
    await close();
    process.exit(1);
  }

  const deals = await collectDealLinks(page);
  if (!deals.length) {
    logErr('В отчёте нет ссылок на сделки');
    await close();
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
        info(`${prefix} — ${formatComment(result)}`);
        printDealIssues(result);
        info('');
      }
    } catch (err) {
      const msg = String(err.message || err);
      if (/closed|Target page|has been closed|browser has been closed/i.test(msg)) {
        info(`${prefix} — остановлено (браузер закрыт)`);
        break;
      }
      const comment = 'не удалось проверить сделку';
      const detail = `Не удалось открыть или прочитать сделку: ${msg}`;
      results.push({
        id: deal.id,
        title: deal.title,
        url: deal.url,
        ok: false,
        checkFailed: true,
        errors: [detail],
        issues: [{ comment, detail }],
        details: {},
      });
      info(`${prefix} — ${comment}`);
      info(`  ${detail}`);
      info('');
    }

    try {
      writeReport(results);
    } catch (err) {
      logWarn(`Не удалось сохранить отчёт: ${err.message || err}`);
    }

    await sleep(config.delayBetweenDealsMs);
  }

  printSummary(results);
  let reportFile = '';
  try {
    reportFile = writeReport(results, { final: true });
    info(`Excel-отчёт: ${reportFile}`);
    info('Excel: лист «Нужно исправить» — по одной строке на замечание.\n');
    openReport(reportFile);
  } catch (err) {
    logWarn(`Не удалось сохранить Excel: ${err.message || err}`);
  }

  if (process.env.SKIP_PAUSE === '1' || process.env.AUTO_CLOSE === '1') {
    info('Готово (AUTO_CLOSE).');
    await sleep(800);
  } else if (guiMode) {
    info('Готово. Браузер можно закрыть.');
    await sleep(1500);
  } else {
    await waitForEnter('Готово. Enter — закрыть браузер...');
  }
  await close();
}

function browserLaunchArgs() {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (process.platform === 'linux') args.push('--no-sandbox');
  if (process.platform === 'win32') {
    args.push(
      '--disable-dev-shm-usage',
      '--disable-features=TranslateUI',
      '--disable-hang-monitor',
      '--disable-component-update'
    );
  }
  return args;
}

function resolveChromeExecutable() {
  const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (custom && fs.existsSync(custom)) return custom;

  if (process.platform !== 'win32') return '';

  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  return candidates.find((p) => fs.existsSync(p)) || '';
}

async function launchBrowserContext() {
  const args = browserLaunchArgs();
  const common = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    acceptDownloads: true,
    args,
  };

  const launchAttempts = [];

  if (config.useSystemChrome) {
    const exe = resolveChromeExecutable();
    if (exe) {
      launchAttempts.push({ label: `Chrome (${exe})`, options: { ...common, executablePath: exe } });
    }
    launchAttempts.push({ label: 'Chrome channel', options: { ...common, channel: 'chrome' } });
  }

  launchAttempts.push({ label: 'Playwright Chromium', options: { ...common } });

  const useProfile = config.persistentProfile !== false;
  const profileDir = path.resolve(
    __dirname,
    config.persistentProfileDir || '.browser-profile'
  );

  let lastErr = null;
  for (const attempt of launchAttempts) {
    try {
      if (useProfile) {
        fs.mkdirSync(profileDir, { recursive: true });
        logStep('браузер', `${attempt.label}, профиль: ${profileDir}`);
        const context = await chromium.launchPersistentContext(profileDir, attempt.options);
        return {
          context,
          close: async () => {
            await context.close().catch(() => {});
          },
        };
      }

      logStep('браузер', attempt.label);
      const browser = await chromium.launch(attempt.options);
      const context = await browser.newContext({
        viewport: common.viewport,
        locale: common.locale,
        acceptDownloads: common.acceptDownloads,
      });
      return {
        context,
        close: async () => {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        },
      };
    } catch (err) {
      lastErr = err;
      logWarn(`Не удалось запустить (${attempt.label}): ${err.message || err}`);
    }
  }

  logErr('Не удалось запустить браузер Playwright.');
  info('Выполните один раз: npx playwright install chromium');
  throw lastErr || new Error('browser launch failed');
}

main().catch((err) => {
  logErr(`Критическая ошибка: ${err.message || err}`);
  if (config.verbose) console.error(err);
  process.exit(1);
});
