const {
  normalizeHref,
  prefersKey,
  getCachedAmount,
  setCachedAmount,
  mapPool,
  clearInvoiceCache,
} = require('../src/invoiceCache');

let fail = 0;
function assert(name, cond, detail) {
  if (cond) console.log('OK  ', name);
  else {
    fail++;
    console.log('FAIL', name, detail || '');
  }
}

clearInvoiceCache();

assert(
  'normalize strips hash',
  normalizeHref('https://x/disk/uf.php?id=1#frag') === 'https://x/disk/uf.php?id=1'
);

assert('prefers sorted', prefersKey([200, 50.5, 200]) === '50.5,200');

setCachedAmount('https://x/a.pdf', [100, 200], 200);
assert('cache hit', getCachedAmount('https://x/a.pdf', [200, 100]) === 200);
assert('cache miss other prefers', getCachedAmount('https://x/a.pdf', [300]) === undefined);

(async () => {
  const started = Date.now();
  const order = [];
  const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
    order.push(`s${n}`);
    await new Promise((r) => setTimeout(r, 40));
    order.push(`e${n}`);
    return n * 10;
  });
  const elapsed = Date.now() - started;
  assert('mapPool results', out.join(',') === '10,20,30,40');
  assert('mapPool faster than serial', elapsed < 140, `elapsed=${elapsed}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
