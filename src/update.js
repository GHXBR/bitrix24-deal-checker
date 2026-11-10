/**
 * Обновление установленной копии с GitHub (ветка main).
 * Сохраняет .browser-profile, results, runtime и локальный Node.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
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

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'bitrix24-deal-checker',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetJson(res.headers.location).then(resolve, reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
  });
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
  const data = await httpsGetJson(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`);
  return {
    commit: String(data.sha || '').slice(0, 40),
    message: String((data.commit && data.commit.message) || '').split('\n')[0],
    date: (data.commit && data.commit.committer && data.commit.committer.date) || '',
  };
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

function copyUpdatedTree(srcRoot, destRoot) {
  const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (KEEP_NAMES.has(entry.name)) continue;
    const from = path.join(srcRoot, entry.name);
    const to = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(to, { recursive: true, force: true });
      copyDirRecursive(from, to);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
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
  copyUpdatedTree(srcRoot, root);
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

  fs.rmSync(tmp, { recursive: true, force: true });
  say('Обновление установлено.');
  return { updated: true, ...status };
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
