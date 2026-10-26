'use strict';
// Where Sparkguard keeps its state. Nothing is written inside the user's workspace.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const HOME = process.env.HOME || os.homedir();
const CONFIG_DIR = process.env.SPARKGUARD_CONFIG_DIR || path.join(HOME, '.config', 'sparkguard');
const DATA_DIR = process.env.SPARKGUARD_DATA_DIR || path.join(HOME, '.local', 'share', 'sparkguard');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// A project is the nearest ancestor with a .git directory, else the cwd itself.
function projectRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd || process.cwd());
    dir = parent;
  }
}

// Identity that follows the repository across clones and machines: the root
// commit hash. Muse Code's own memory is keyed by absolute path, so a teammate's
// checkout or a CI run starts without it. Falls back to the path.
function repoKey(root) {
  const cacheFile = path.join(DATA_DIR, 'repo-keys.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* empty */ }
  if (cache[root]) return cache[root];
  let key = `path:${root}`;
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 });
    const first = (r.stdout || '').trim().split('\n').filter(Boolean).sort()[0];
    if (r.status === 0 && /^[0-9a-f]{40}$/.test(first || '')) key = `git:${first}`;
  } catch { /* not a git repo */ }
  if (key.startsWith('git:')) {
    cache[root] = key;
    try { ensureDir(DATA_DIR); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* cache is optional */ }
  }
  return key;
}

function projectId(root) {
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function projectDataDir(root) {
  return ensureDir(path.join(DATA_DIR, 'projects', projectId(root)));
}

module.exports = { HOME, CONFIG_DIR, DATA_DIR, ensureDir, projectRoot, repoKey, projectId, projectDataDir };
