'use strict';
// Where Said No keeps its state. Nothing is written inside the user's workspace.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const HOME = process.env.HOME || os.homedir();
const CONFIG_DIR = process.env.SAID_NO_CONFIG_DIR || path.join(HOME, '.config', 'said-no');
const DATA_DIR = process.env.SAID_NO_DATA_DIR || path.join(HOME, '.local', 'share', 'said-no');

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

function projectId(root) {
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function projectDataDir(root) {
  return ensureDir(path.join(DATA_DIR, 'projects', projectId(root)));
}

module.exports = { HOME, CONFIG_DIR, DATA_DIR, ensureDir, projectRoot, projectId, projectDataDir };
