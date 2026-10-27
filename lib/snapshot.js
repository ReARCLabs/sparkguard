'use strict';
// Pre-write snapshots so an agent's file changes can be undone. Muse Code's own
// rewind restores conversation history only, not workspace files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectDataDir } = require('./paths');
const { withLock } = require('./lock');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;

function stepsFile(root) { return path.join(projectDataDir(root), 'steps.jsonl'); }
function blobDir(root) {
  const d = path.join(projectDataDir(root), 'blobs');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function inside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// True when some existing directory between root and abs is a symlink: writing
// there would land outside what the snapshot recorded.
function linkedAncestor(root, abs) {
  let cur = root;
  for (const part of path.relative(root, path.dirname(abs)).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try { if (fs.lstatSync(cur).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
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
    // Only the workspace is snapshotted; undo never reaches outside it.
    if (seen.has(p) || !inside(root, path.resolve(root, p))) continue;
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
  // Numbered under a lock: parallel hooks must not hand out the same step twice.
  return withLock(stepsFile(root), () => {
    const lines = readSteps(root);
    const step = {
      step: lines.length ? Math.max(...lines.map((l) => Number(l.step) || 0)) + 1 : 1,
      at: new Date().toISOString(),
      tool_use_id, session_id, tool, summary,
      entries: entries.map((e) => ({ ...e, path: path.relative(root, e.path) })),
    };
    fs.appendFileSync(stepsFile(root), `${JSON.stringify(step)}\n`, { mode: 0o600 });
    return step;
  });
}

function readSteps(root) {
  let text = '';
  try { text = fs.readFileSync(stepsFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn line loses only itself */ }
  }
  return out;
}

// Restore files to their state before `stepNo` (default: the last step).
// Files that did not exist before are removed; changed or deleted files come back.
function undo(root, stepNo) {
  const steps = readSteps(root);
  let step;
  if (stepNo === undefined || stepNo === null || stepNo === '') step = steps[steps.length - 1];
  else {
    const n = typeof stepNo === 'number' || (typeof stepNo === 'string' && /^\d+$/.test(stepNo)) ? Number(stepNo) : NaN;
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'step must be a positive integer' };
    step = steps.find((s) => s.step === n);
  }
  if (!step) return { ok: false, error: 'no such step' };
  const blobs = blobDir(root);
  const restored = [];
  const removed = [];
  const skipped = [];
  const safe = (e) => {
    const abs = path.resolve(root, e.path);
    return inside(root, abs) && !linkedAncestor(root, abs) ? abs : null;
  };
  // directories first so files have somewhere to land
  for (const e of step.entries.filter((x) => x.type === 'dir')) {
    const abs = safe(e);
    if (abs) fs.mkdirSync(abs, { recursive: true });
  }
  for (const e of step.entries) {
    const abs = safe(e);
    if (!abs) { skipped.push(e.path); continue; }
    if (e.type === 'absent') {
      if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); removed.push(e.path); }
    } else if (e.type === 'file') {
      if (e.skipped) { skipped.push(e.path); continue; }
      const blob = path.join(blobs, e.sha256);
      let buf;
      try { buf = fs.readFileSync(blob); } catch { skipped.push(e.path); continue; }
      if (crypto.createHash('sha256').update(buf).digest('hex') !== e.sha256) { skipped.push(e.path); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (linkedAncestor(root, abs)) { skipped.push(e.path); continue; }
      // Replace a symlink with the recorded file instead of writing through it.
      try { if (fs.lstatSync(abs).isSymbolicLink()) fs.unlinkSync(abs); } catch { /* absent */ }
      fs.writeFileSync(abs, buf);
      if (e.mode) fs.chmodSync(abs, e.mode);
      restored.push(e.path);
    } else if (e.type === 'symlink') {
      try { fs.rmSync(abs, { force: true }); fs.symlinkSync(e.target, abs); restored.push(e.path); } catch { skipped.push(e.path); }
    }
  }
  return { ok: true, step: step.step, tool: step.tool, summary: step.summary, restored, removed, skipped };
}

module.exports = { take, undo, readSteps };
