/**
 * Кэш скачанных счетов и уже разобранных сумм.
 * Файл кэшируем по href; сумму — по href + набор граф (preferAmounts),
 * чтобы при других графах итог пересчитался корректно.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fileByHref = new Map(); // hrefKey -> { filePath, fileName }
const amountByKey = new Map(); // parseKey -> number|null
const inflightFiles = new Map(); // hrefKey -> Promise<entry>

function normalizeHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    // оставляем path+query (в Битриксе id файла в query), без hash
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return raw.split('#')[0];
  }
}

function prefersKey(preferAmounts = []) {
  const seen = new Set();
  const list = [];
  for (const n of preferAmounts || []) {
    if (!Number.isFinite(n)) continue;
    const v = Math.round(n * 100) / 100;
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(v);
  }
  return list.sort((a, b) => a - b).join(',');
}

function parseCacheKey(href, preferAmounts) {
  return `${normalizeHref(href)}::${prefersKey(preferAmounts)}`;
}

function getCachedAmount(href, preferAmounts) {
  const key = parseCacheKey(href, preferAmounts);
  if (!amountByKey.has(key)) return undefined;
  return amountByKey.get(key);
}

function setCachedAmount(href, preferAmounts, amount) {
  amountByKey.set(parseCacheKey(href, preferAmounts), amount);
}

function getCachedFile(href) {
  const key = normalizeHref(href);
  const entry = fileByHref.get(key);
  if (!entry) return null;
  if (!fs.existsSync(entry.filePath)) {
    fileByHref.delete(key);
    return null;
  }
  return entry;
}

function setCachedFile(href, entry) {
  fileByHref.set(normalizeHref(href), entry);
}

function getInflight(href) {
  return inflightFiles.get(normalizeHref(href));
}

function setInflight(href, promise) {
  const key = normalizeHref(href);
  inflightFiles.set(key, promise);
  const clear = () => {
    if (inflightFiles.get(key) === promise) inflightFiles.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

function saveBufferToTemp(buffer, suggestedName = 'invoice.bin') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-inv-'));
  const safe = String(suggestedName || 'invoice.bin')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .slice(0, 180);
  const filePath = path.join(tmpDir, safe || 'invoice.bin');
  fs.writeFileSync(filePath, buffer);
  return { filePath, fileName: path.basename(filePath) };
}

function contentHash(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
}

/** Параллельный map с лимитом одновременных задач. */
async function mapPool(items, concurrency, fn) {
  const list = items || [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(concurrency || 2, list.length));
  const out = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}

function cacheStats() {
  return { files: fileByHref.size, amounts: amountByKey.size };
}

function clearInvoiceCache() {
  fileByHref.clear();
  amountByKey.clear();
  inflightFiles.clear();
}

module.exports = {
  normalizeHref,
  prefersKey,
  getCachedAmount,
  setCachedAmount,
  getCachedFile,
  setCachedFile,
  getInflight,
  setInflight,
  saveBufferToTemp,
  contentHash,
  mapPool,
  cacheStats,
  clearInvoiceCache,
};
