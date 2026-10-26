'use strict';
// Optional mirror of rules and decisions to Bilinc (hosted, versioned memory):
// every rule keeps its source and history there, and the decision ledger becomes
// an audit trail. Hooks only append to a local outbox; a detached flusher sends it.
// Without a Bilinc key this is a no-op. A decision never waits on Bilinc.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CONFIG_DIR, ensureDir, projectId, repoKey } = require('./paths');

const BASE = (process.env.BILINC_BASE_URL || 'https://bilinc.space').replace(/\/+$/, '');

function keyFile() { return path.join(CONFIG_DIR, 'bilinc.key'); }
function outboxFile() { return path.join(ensureDir(CONFIG_DIR), 'outbox.jsonl'); }

function readKey() {
  try { return fs.readFileSync(keyFile(), 'utf8').trim() || null; } catch { return process.env.BILINC_API_KEY || null; }
}

function enabled() { return Boolean(readKey()); }

function enqueue(item) {
  if (!enabled()) return false;
  fs.appendFileSync(outboxFile(), `${JSON.stringify({ ...item, queued_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  return true;
}

function ruleItem(rule) {
  return {
    op: 'commit',
    idem: `sparkguard-rule-${projectId(rule.project)}-${rule.id}-${rule.hash}`,
    body: {
      key: `sparkguard:${projectId(rule.project)}:rule:${rule.id}`,
      value: { text: rule.text, kind: rule.kind, paths: rule.paths, commands: rule.commands, keywords: rule.keywords, said_at: rule.said_at, tz: rule.tz, project: rule.project },
      memoryType: 'semantic',
      importance: 1,
      metadata: { app: 'sparkguard', extractor: rule.extractor, origin: rule.source },
      source: 'sparkguard',
      sessionId: rule.session_id || undefined,
    },
  };
}

function decisionItem(root, d) {
  const pid = projectId(repoKey(root));
  return {
    op: 'commit',
    idem: `sparkguard-decision-${pid}-${d.tool_use_id || d.at}`,
    body: {
      key: `sparkguard:${pid}:decision:${d.tool_use_id || d.at}`,
      value: { decision: d.decision, rule: d.rule || null, tool: d.tool, summary: d.summary, why: d.why || null, at: d.at },
      memoryType: 'episodic',
      importance: 0.3,
      metadata: { app: 'sparkguard', path: d.path || null },
      source: 'sparkguard',
      sessionId: d.session_id || undefined,
    },
  };
}

function forgetItem(rule) {
  return {
    op: 'forget',
    idem: `sparkguard-forget-${projectId(rule.project)}-${rule.id}`,
    body: { key: `sparkguard:${projectId(rule.project)}:rule:${rule.id}`, reason: 'user asked Sparkguard to forget this rule' },
  };
}

// Fire-and-forget: start a detached flusher so the hook can exit immediately.
function kick() {
  if (!enabled()) return;
  try {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'flush.js')], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch { /* outbox keeps it for next time */ }
}

async function flush({ timeoutMs = 8000 } = {}) {
  const key = readKey();
  if (!key) return { sent: 0, left: 0, skipped: 'no-key' };
  const file = outboxFile();
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch { return { sent: 0, left: -1, skipped: 'locked' }; }
  try {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return { sent: 0, left: 0 }; }
    const left = [];
    let sent = 0;
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const url = `${BASE}/api/cloud/memory/${item.op === 'forget' ? 'forget' : 'commit'}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': item.idem, 'X-Bilinc-Client': 'sparkguard' },
          body: JSON.stringify(item.body),
        });
        if (res.ok || res.status === 409) sent++;
        else if (res.status >= 500 || res.status === 429) left.push(line);
        // other 4xx: drop; a malformed item must not block the queue forever
      } catch {
        left.push(line);
      } finally {
        clearTimeout(t);
      }
    }
    fs.writeFileSync(file, left.length ? `${left.join('\n')}\n` : '', { mode: 0o600 });
    return { sent, left: left.length };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

module.exports = { enabled, enqueue, ruleItem, decisionItem, forgetItem, kick, flush, outboxFile };
