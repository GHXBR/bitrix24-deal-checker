/**
 * Скачать вложения предоплаты Ю26-0229 и разобрать суммы.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const { extractAmountFromInvoiceFile } = require('../src/invoiceAmount');

const DEAL = 'https://onvicom.bitrix24.ru/crm/deal/details/4994/';
const PREFERS = [580, 9500.14, 18130, 93000];
const outDir = path.join(__dirname, '..', 'results', 'debug-4994');
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const profile = path.join(__dirname, '..', config.persistentProfileDir || '.browser-profile');
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(DEAL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const frame =
    page.frames().find((f) => /deal\/details\/4994/i.test(f.url()) && /IFRAME/i.test(f.url())) ||
    page.mainFrame();

  const files = await frame.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a')) {
      const t = (a.textContent || '').trim();
      const href = a.href || '';
      if (!href) continue;
      if (
        /\.(pdf|xls|xlsx)$/i.test(t) ||
        /schet|счет|счёт/i.test(t) ||
        href.includes('crm_show_file.php') ||
        href.includes('disk/uf.php')
      ) {
        out.push({ fileName: t, href });
      }
    }
    return out;
  });

  console.log('links', files.length);
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.href)) continue;
    seen.add(f.href);
    if (!/1511|0761902|6624|45301908|С-12|schet/i.test(f.fileName + f.href)) continue;
    console.log('\nFILE', f.fileName);
    try {
      const res = await page.request.get(f.href, { timeout: 20000 });
      const buf = Buffer.from(await res.body());
      const safe = f.fileName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'file.bin';
      const fp = path.join(outDir, safe);
      fs.writeFileSync(fp, buf);
      console.log('saved', fp, 'bytes', buf.length);
      const amount = await extractAmountFromInvoiceFile(fp, { preferAmounts: PREFERS });
      console.log('amount', amount);
      const amountU = await extractAmountFromInvoiceFile(fp, {
        preferAmounts: [580, 93000],
      });
      console.log('amount unmatched-only', amountU);
    } catch (err) {
      console.log('ERR', err.message || err);
    }
  }

  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
