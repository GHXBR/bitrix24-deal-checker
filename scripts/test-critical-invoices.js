/**
 * Регрессия по известным «ломающим» счетам.
 * Запуск: node scripts/test-critical-invoices.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractAmountFromInvoiceFile } = require('../src/invoiceAmount');

function findLatest(namePart) {
  const root = path.join(os.tmpdir());
  const dirs = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('bx-inv-'))
    .map((d) => path.join(root, d))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().includes(namePart.toLowerCase())) {
        return path.join(dir, f);
      }
    }
  }
  return null;
}

let fail = 0;
async function check(label, fileHint, prefer, expect) {
  const fp = findLatest(fileHint);
  if (!fp) {
    console.log('SKIP', label, `(нет файла *${fileHint}* в Temp)`);
    return;
  }
  const got = await extractAmountFromInvoiceFile(fp, { preferAmounts: prefer });
  const ok = got === expect || (got != null && expect != null && Math.abs(got - expect) < 0.02);
  if (!ok) fail += 1;
  console.log(ok ? 'OK  ' : 'FAIL', label, '=>', got, 'want', expect, path.basename(fp));
}

(async () => {
  await check('6624 = 93000 (не ИНН)', '6624', [580, 9500.14, 18130, 93000], 93000);
  await check('1511 = 18130', '1511', [580, 9500.14, 18130, 93000], 18130);
  await check('0761902 = 9500.14', '0761902', [580, 9500.14, 18130, 93000], 9500.14);
  await check('45301908 = 5480 (не 4900)', '45301908', [4900, 21240], 5480);
  await check('CDEK 27014 прописью', '50190404324', [27014, 66500, 164000], 27014);
  await check('CDEK 3542 прописью', '50190365380', [3542, 83200], 3542);
  await check('xls 70455 справа от Итого', '0770444', [70455, 1433.51], 70455);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
