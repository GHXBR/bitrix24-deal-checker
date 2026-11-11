/**
 * Общие фильтры имён файлов счетов.
 */

function isOutgoingClientInvoiceName(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;
  if (n.includes('исходящ')) return true;
  if (/сч[её]т\s+на\s+оплату\s+№\s*ю\d{2}/i.test(n)) return true;
  if (/сч[её]т\s+на\s+оплату\s+№\s*(нал|qr)[-–]?\s*ю?/i.test(n)) return true;
  return false;
}

module.exports = { isOutgoingClientInvoiceName };
