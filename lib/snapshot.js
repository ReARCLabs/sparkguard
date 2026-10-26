'use strict';
// Pre-write snapshots so an agent's file changes can be undone. Muse Code's own
// rewind restores conversation history only, not workspace files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectDataDir } = require('./paths');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;

function stepsFile(root) { return path.join(projectDataDir(root), 'steps.jsonl'); }
function blobDir(root) {
  const d = path.join(projectDataDir(root), 'blobs');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function walk(p, out, budget) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) { out.push({ path: p, type: 'symlink', target: fs.readlinkSync(p) }); return; }
  if (st.isDirectory()) {
    if (path.basename(p) === '.git' || path.basename(p) === 'node_modules') return;
    out.push({ path: p, type: 'dir' });
    for (const name of fs.readdirSync(p)) walk(path.join(p, name), out, budget);
    return;
  }
  if (!st.isFile()) return;
  if (st.size > MAX_FILE || budget.used + st.size > MAX_TOTAL) { out.push({ path: p, type: 'file', skipped: 'too-large', size: st.size }); return; }
  budget.used += st.size;
  out.push({ path: p, type: 'file', size: st.size, mode: st.mode & 0o777 });
}

// Record the state of `paths` before a tool call runs. Returns the step entry.
function take(root, { tool_use_id, session_id, tool, summary, paths }) {
  const entries = [];
  const budget = { used: 0 };
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (!fs.existsSync(p)) { entries.push({ path: p, type: 'absent' }); continue; }
    walk(p, entries, budget);
  }
  const blobs = blobDir(root);
  for (const e of entries) {
    if (e.type !== 'file' || e.skipped) continue;
    const buf = fs.readFileSync(e.path);
    e.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const blob = path.join(blobs, e.sha256);
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, buf, { mode: 0o600 });
  }
  const lines = readSteps(root);
  const step = {
    step: lines.length ? lines[lines.length - 1].step + 1 : 1,
    at: new Date().toISOString(),
    tool_use_id, session_id, tool, summary,
    entries: entries.map((e) => ({ ...e, path: path.relative(root, e.path) })),
  };
  fs.appendFileSync(stepsFile(root), `${JSON.stringify(step)}\n`, { mode: 0o600 });
  return step;
}

function readSteps(root) {
  try {
    return fs.readFileSync(stepsFile(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// Restore files to their state before `stepNo` (default: the last step).
// Files that did not exist before are removed; changed or deleted files come back.
function undo(root, stepNo) {
  const steps = readSteps(root);
  const step = stepNo ? steps.find((s) => s.step === Number(stepNo)) : steps[steps.length - 1];
  if (!step) return { ok: false, error: 'no such step' };
  const blobs = blobDir(root);
  const restored = [];
  const removed = [];
  const skipped = [];
  // directories first so files have somewhere to land
  for (const e of step.entries.filter((x) => x.type === 'dir')) fs.mkdirSync(path.join(root, e.path), { recursive: true });
  for (const e of step.entries) {
    const abs = path.join(root, e.path);
    if (e.type === 'absent') {
      if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); removed.push(e.path); }
    } else if (e.type === 'file') {
      if (e.skipped) { skipped.push(e.path); continue; }
      const blob = path.join(blobs, e.sha256);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(blob, abs);
      if (e.mode) fs.chmodSync(abs, e.mode);
      restored.push(e.path);
    } else if (e.type === 'symlink') {
      try { fs.rmSync(abs, { force: true }); fs.symlinkSync(e.target, abs); restored.push(e.path); } catch { skipped.push(e.path); }
    }
  }
  return { ok: true, step: step.step, tool: step.tool, summary: step.summary, restored, removed, skipped };
}

module.exports = { take, undo, readSteps };
