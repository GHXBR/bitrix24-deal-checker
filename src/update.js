/**
 * Обновление установленной копии с GitHub (ветка main).
 * Сохраняет .browser-profile, results, runtime и локальный Node.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');

const REPO = 'GHXBR/bitrix24-deal-checker';
const BRANCH = 'main';
const META_FILE = '.app-version.json';

const KEEP_NAMES = new Set([
  'node_modules',
  '.browser-profile',
  'results',
  'runtime',
  '.git',
  META_FILE,
  '.auth',
]);

function rootDir() {
  return path.resolve(__dirname, '..');
}

function metaPath() {
  return path.join(rootDir(), META_FILE);
}

function readLocalMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
  } catch {
    return { commit: '', installedAt: '' };
  }
}

function writeLocalMeta(meta) {
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2), 'utf8');
}

function httpsGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'bitrix24-deal-checker',
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetText(res.headers.location, headers).then(resolve, reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 403 || res.statusCode === 429) {
            reject(
              new Error(
                'GitHub временно ограничил запросы с этого IP. Подождите около часа или нажмите «Обновления» позже.'
              )
            );
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Не удалось связаться с GitHub (HTTP ${res.statusCode}).`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
  });
}

function parseAtomHead(xml) {
  const entry = xml.match(/<entry\b[\s\S]*?<\/entry>/i);
  if (!entry) throw new Error('Не удалось прочитать ленту коммитов GitHub.');
  const block = entry[0];
  const id =
    (block.match(/<id>\s*tag:github\.com,2008:Grit::Commit\/([0-9a-f]{7,40})\s*<\/id>/i) || [])[1] ||
    (block.match(/\/commit\/([0-9a-f]{7,40})/i) || [])[1] ||
    '';
  if (!id) throw new Error('Не удалось определить версию на GitHub.');
  const titleRaw = ((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const message = titleRaw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const date = ((block.match(/<updated>\s*([^<]+)\s*<\/updated>/i) || [])[1] || '').trim();
  return {
    commit: id.slice(0, 40),
    message: message || 'Обновление с GitHub',
    date,
  };
}

async function httpsGetJson(url) {
  const data = await httpsGetText(url, { Accept: 'application/vnd.github+json' });
  try {
    return JSON.parse(data);
  } catch (err) {
    throw new Error('Некорректный ответ GitHub API.');
  }
}

function httpsDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (current) => {
      https
        .get(current, { headers: { 'User-Agent': 'bitrix24-deal-checker' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Скачивание не удалось: HTTP ${res.statusCode}`));
            return;
          }
          const out = createWriteStream(dest);
          pipeline(res, out).then(resolve).catch(reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

async function fetchRemoteHead() {
  // Atom-лента не использует лимит GitHub API (60 req/час без токена).
  try {
    const xml = await httpsGetText(`https://github.com/${REPO}/commits/${BRANCH}.atom`, {
      Accept: 'application/atom+xml, application/xml, text/xml, */*',
    });
    return parseAtomHead(xml);
  } catch (atomErr) {
    try {
      const data = await httpsGetJson(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`);
      return {
        commit: String(data.sha || '').slice(0, 40),
        message: String((data.commit && data.commit.message) || '').split('\n')[0],
        date: (data.commit && data.commit.committer && data.commit.committer.date) || '',
      };
    } catch {
      throw atomErr;
    }
  }
}

async function checkForUpdates() {
  const local = readLocalMeta();
  const remote = await fetchRemoteHead();
  return {
    localCommit: local.commit || '',
    remoteCommit: remote.commit,
    message: remote.message,
    date: remote.date,
    updateAvailable: !local.commit || local.commit !== remote.commit,
  };
}

function expandZipWithPowerShell(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ps = `
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force
`;
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Expand-Archive failed');
  }
}

function isBusyError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

const DEFER_EXE_NAMES = new Set(['Проверка сделок.exe', 'Установить.exe']);

function copyFileReplace(from, to, pending) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Запущенный exe нельзя перезаписать — всегда откладываем до перезапуска.
  if (DEFER_EXE_NAMES.has(path.basename(to))) {
    const pendingPath = to + '.pending';
    fs.copyFileSync(from, pendingPath);
    pending.push({ from: pendingPath, to });
    return;
  }
  try {
    fs.copyFileSync(from, to);
  } catch (err) {
    if (!isBusyError(err)) throw err;
    const pendingPath = to + '.pending';
    fs.copyFileSync(from, pendingPath);
    pending.push({ from: pendingPath, to });
  }
}

function copyUpdatedTree(srcRoot, destRoot) {
  const pending = [];
  const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (KEEP_NAMES.has(entry.name)) continue;
    const from = path.join(srcRoot, entry.name);
    const to = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      // Не сносим целиком занятые каталоги — копируем поверх.
      copyDirRecursive(from, to, pending);
    } else {
      copyFileReplace(from, to, pending);
    }
  }
  return pending;
}

function copyDirRecursive(src, dest, pending) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to, pending);
    else copyFileReplace(from, to, pending);
  }
}

function scheduleRestart(root, pending, relaunchExe) {
  const listPath = path.join(root, '.update-pending.json');
  fs.writeFileSync(
    listPath,
    JSON.stringify({ pending: pending || [], relaunchExe: relaunchExe || '' }, null, 2),
    'utf8'
  );

  // Ждём закрытия GUI (UPDATE_HOST_PID), затем подменяем exe и запускаем снова.
  const hostPid = Number(process.env.UPDATE_HOST_PID || 0) || Number(process.ppid || 0) || 0;

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$hostPid = ${hostPid}
$nodePid = ${process.pid}
Start-Sleep -Milliseconds 400
if ($nodePid -gt 0) { try { Wait-Process -Id $nodePid -Timeout 60 } catch {} }
if ($hostPid -gt 0) { try { Wait-Process -Id $hostPid -Timeout 300 } catch {} }
Start-Sleep -Milliseconds 700
$root = '${root.replace(/'/g, "''")}'
$listPath = Join-Path $root '.update-pending.json'
$relaunch = '${String(relaunchExe || '').replace(/'/g, "''")}'
if (Test-Path -LiteralPath $listPath) {
  $data = Get-Content -LiteralPath $listPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($data.relaunchExe) { $relaunch = [string]$data.relaunchExe }
  foreach ($item in @($data.pending)) {
    $from = [string]$item.from
    $to = [string]$item.to
    if ($from -and $to -and (Test-Path -LiteralPath $from)) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
      for ($i = 0; $i -lt 30; $i++) {
        try {
          Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop
          break
        } catch {
          Start-Sleep -Milliseconds 350
        }
      }
    }
  }
  Remove-Item -LiteralPath $listPath -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -LiteralPath $root -Filter '*.pending' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if ($relaunch -and (Test-Path -LiteralPath $relaunch)) {
  Start-Process -FilePath $relaunch -WorkingDirectory $root
}
`;

  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps],
    {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.unref();
}

function findExtractedRoot(extractDir) {
  const kids = fs.readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (kids.length === 1) return path.join(extractDir, kids[0].name);
  return extractDir;
}

async function applyUpdate({ onProgress } = {}) {
  const say = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };

  const status = await checkForUpdates();
  if (!status.updateAvailable) {
    return { updated: false, ...status };
  }

  const root = rootDir();
  const tmp = path.join(root, '.update-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const zipPath = path.join(tmp, 'repo.zip');
  const extractDir = path.join(tmp, 'extract');

  say('Скачиваю обновление с GitHub...');
  await httpsDownload(`https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`, zipPath);

  say('Распаковываю...');
  expandZipWithPowerShell(zipPath, extractDir);
  const srcRoot = findExtractedRoot(extractDir);

  const packageBefore = safeRead(path.join(root, 'package-lock.json'));
  say('Копирую файлы (профиль браузера и отчёты сохраняются)...');
  const pending = copyUpdatedTree(srcRoot, root);
  const packageAfter = safeRead(path.join(root, 'package-lock.json'));

  writeLocalMeta({
    commit: status.remoteCommit,
    installedAt: new Date().toISOString(),
    message: status.message,
    date: status.date,
  });

  if (packageBefore !== packageAfter || !fs.existsSync(path.join(root, 'node_modules'))) {
    say('Обновляю зависимости npm...');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const install = spawnSync(npm, ['install', '--no-fund', '--no-audit'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: process.env,
    });
    if (install.status !== 0) {
      throw new Error(install.stderr || install.stdout || 'npm install failed');
    }
  }

  // Архив больше не нужен; .pending для exe уже в корне приложения.
  fs.rmSync(tmp, { recursive: true, force: true });

  const relaunchExe = path.join(root, 'Проверка сделок.exe');
  say('Обновление готово. Перезапускаю приложение...');
  scheduleRestart(root, pending, relaunchExe);

  return {
    updated: true,
    needsRestart: true,
    pendingCount: pending.length,
    ...status,
  };
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

module.exports = {
  REPO,
  BRANCH,
  META_FILE,
  readLocalMeta,
  writeLocalMeta,
  checkForUpdates,
  applyUpdate,
  fetchRemoteHead,
};
