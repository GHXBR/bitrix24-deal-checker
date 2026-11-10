#!/usr/bin/env node
/**
 * CLI для проверки/установки обновлений (используется GUI и установщиком).
 *   node scripts/update-cli.js check
 *   node scripts/update-cli.js apply
 */

const { checkForUpdates, applyUpdate, readLocalMeta } = require('../src/update');

async function main() {
  const cmd = (process.argv[2] || 'check').toLowerCase();
  if (cmd === 'meta') {
    process.stdout.write(JSON.stringify(readLocalMeta()) + '\n');
    return;
  }
  if (cmd === 'check') {
    const status = await checkForUpdates();
    process.stdout.write(JSON.stringify(status) + '\n');
    return;
  }
  if (cmd === 'apply') {
    const result = await applyUpdate({
      onProgress: (msg) => process.stderr.write(msg + '\n'),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  console.error('Usage: node scripts/update-cli.js [check|apply|meta]');
  process.exit(2);
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
