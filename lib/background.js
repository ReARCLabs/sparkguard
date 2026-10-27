'use strict';
// Background routing. The strict regex gate keeps the prompt hook fast, but it misses
// rules phrased in ways it does not know ("scripts/deploy.sh is mine, leave it").
// Prompts with softer rule language, or that name a file or folder in the repo, are
// routed by Muse Spark in a detached process instead: the prompt is not delayed, and
// the rule is usually active about 2 s later. Only add_rule is ever applied here;
// consent and withdrawal stay synchronous and explicit.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const capture = require('./capture');
const model = require('./model');
const { projectDataDir } = require('./paths');
const { pause } = require('./lock');

const SHARE = 0.6; // background stops at 60% of the spend cap; the referee keeps the rest
const MARKER_MS = 15000;
const PATHLIKE = /[\w.-]+\/[\w*./-]*|\b[\w-]+\.(js|jsx|ts|tsx|py|json|ya?ml|toml|sql|sh|lock|md|go|rs|rb|java|kt|swift|c|cc|cpp|h|tf|csv)\b|(^|\s)\.env[\w.]*/;

const dir = (root, name) => {
  const d = path.join(projectDataDir(root), name);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const safe = (sid) => String(sid || 'none').replace(/[^\w.-]/g, '_');

function topLevelNames(root) {
  try {
    return fs.readdirSync(root).filter((n) => n.length >= 3 && !n.startsWith('.git') && n !== 'node_modules').slice(0, 60);
  } catch { return []; }
}

// Should this prompt (which the strict gate skipped) be routed in the background?
function wanted(text, root) {
  if (process.env.SPARKGUARD_BACKGROUND === '0' || !model.available({ share: SHARE })) return false;
  const words = text.split(/\s+/).length;
  if (words < 4 || words > 400) return false;
  if (capture.WIDE.test(text)) return true;
  if (PATHLIKE.test(text)) return true;
  return topLevelNames(root).some((n) => new RegExp(`(^|[^\\w./-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text));
}

// The prompt goes in a 0600 file, never on the command line (visible in ps).
function enqueue(root, sid, text) {
  try {
    const job = path.join(dir(root, 'pending'), `${safe(sid)}-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(job, JSON.stringify({ text, cwd: root, session_id: sid, at: new Date().toISOString() }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'route.js'), job], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return job;
  } catch { return null; }
}

function pendingFor(root, sid) {
  let names = [];
  try { names = fs.readdirSync(path.join(projectDataDir(root), 'pending')); } catch { return []; }
  const now = Date.now();
  return names.filter((n) => n.startsWith(`${safe(sid)}-`) && now - Number(n.split('-').slice(-2)[0]) < MARKER_MS);
}

// Called by the guard before a mutating call: if this session has a message still being
// routed, wait briefly so a rule said in the same message applies to this call.
function settle(root, sid, maxMs = 2500) {
  const end = Date.now() + maxMs;
  while (pendingFor(root, sid).length && Date.now() < end) pause(50);
}

function announce(root, sid, rule) {
  fs.appendFileSync(path.join(dir(root, 'announce'), `${safe(sid)}.jsonl`), `${JSON.stringify({ id: rule.id, text: rule.text })}\n`, { mode: 0o600 });
}

function takeAnnouncements(root, sid) {
  const file = path.join(projectDataDir(root), 'announce', `${safe(sid)}.jsonl`);
  const taken = `${file}.${process.pid}.taken`;
  try { fs.renameSync(file, taken); } catch { return []; }
  try {
    return fs.readFileSync(taken, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally { try { fs.unlinkSync(taken); } catch { /* gone */ } }
}

// Runs in the detached child (bin/route.js).
async function run(jobFile) {
  const { recordRule } = require('./prompt');
  const intent = require('./intent');
  const store = require('./store');
  const session = require('./session');
  const { ledger } = require('./decide');
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { return; }
  const root = job.cwd;
  const sid = job.session_id;
  const t0 = Date.now();
  try {
    const actions = await intent.route(job.text, { rules: store.active(root), recap: session.recap(root, sid), lastBlock: null, root, timeoutMs: 8000, share: SHARE });
    const added = [];
    for (const a of actions) {
      if (a.type !== 'add_rule' || (a.confidence ?? 0) < 0.7) continue;
      const rule = recordRule(a, { text: job.text, root, sid, routedBy: 'background' });
      if (rule) { announce(root, sid, rule); added.push(rule.id); }
    }
    ledger(root, { decision: 'prompt-routed', via: 'background', ms: Date.now() - t0, session_id: sid, actions: actions.map((a) => ({ type: a.type, confidence: a.confidence })), added });
  } catch (e) {
    ledger(root, { decision: 'prompt-routed', via: 'background', error: String(e && e.message || e).slice(0, 80), ms: Date.now() - t0, session_id: sid });
  } finally {
    try { fs.unlinkSync(jobFile); } catch { /* gone */ }
  }
}

module.exports = { wanted, enqueue, pendingFor, settle, takeAnnouncements, run, SHARE };
