const fs = require('fs');
const path = require('path');
const { log, logWarn } = require('./log');

/** Текст всех фреймов страницы (для debug-дампа). */
async function collectFrameTexts(page) {
  const parts = [];
  for (const frame of page.frames()) {
    let text = '';
    let url = '';
    try {
      url = frame.url();
      text = await frame.evaluate(() => (document.body && document.body.innerText) || '');
    } catch (err) {
      text = `[frame unreadable: ${err.message}]`;
    }
    parts.push({
      url,
      isMain: frame === page.mainFrame(),
      len: text.length,
      text,
    });
  }
  return parts;
}

function saveDebugDump(dealId, text, meta = {}, frameParts = []) {
  try {
    const dir = path.join(process.cwd(), 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `debug_${dealId}.txt`);
    const head = Object.entries(meta)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const framesBlock = frameParts
      .map(
        (p, i) =>
          `--- frame[${i}] len=${p.len} main=${p.isMain} url=${p.url} ---\n${String(p.text || '').slice(0, 4000)}`
      )
      .join('\n\n');
    fs.writeFileSync(
      file,
      `${head}\n\n===== FRAMES =====\n${framesBlock}\n\n===== MERGED TEXT =====\n${text}`,
      'utf8'
    );
    log(`  debug-дамп сохранён: ${file}`);
    return file;
  } catch (err) {
    logWarn(`  не удалось сохранить debug: ${err.message}`);
    return null;
  }
}

module.exports = {
  collectFrameTexts,
  saveDebugDump,
};
