#!/usr/bin/env node
/**
 * Одна команда для любой ОС:
 *   node start.js
 *
 * Сам ставит зависимости и браузер (если нужно), потом запускает проверку.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = __dirname;
process.chdir(root);

const isWin = process.platform === 'win32';

function say(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  });
  return result.status === 0;
}

function hasDeps() {
  return fs.existsSync(path.join(root, 'node_modules', 'playwright'));
}

function chromiumOk() {
  try {
    const { chromium } = require(path.join(root, 'node_modules', 'playwright'));
    const p = chromium.executablePath();
    return p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function main() {
  say('');
  say('Проверка сделок Битрикс24');
  say(
    `Система: ${os.type()} ${os.release()} (${process.platform}/${process.arch}), Node ${process.version}`
  );
  say('');

  if (!hasDeps()) {
    say('Ставлю зависимости (первый раз, подождите)...');
    if (!run('npm', ['install', '--no-fund', '--no-audit'])) {
      fail(
        'Не удалось установить пакеты.\nПроверьте интернет. Node.js скачайте с https://nodejs.org (версия LTS).'
      );
    }
  }

  if (!chromiumOk()) {
    say('Ставлю браузер Chromium (первый раз, подождите)...');
    if (!run('npx', ['playwright', 'install', 'chromium'])) {
      fail('Не удалось установить браузер. Проверьте интернет и запустите снова: node start.js');
    }
  }

  say('Запуск...\n');

  const child = spawn(process.execPath, [path.join(root, 'check-deals.js')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code) => process.exit(code || 0));
  child.on('error', (err) => fail(err.message || String(err)));
}

main();
