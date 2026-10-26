'use strict';
// Pull this repo's rules from Bilinc at session start, so a rule said on one
// machine applies on a teammate's machine and in CI. Adds missing rules only;
// it never deletes a local rule. Bounded by a short timeout; failures are silent.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const mirror = require('./mirror');
const { CONFIG_DIR, repoKey, projectId } = require('./paths');

const BASE = (process.env.BILINC_BASE_URL || 'https://bilinc.space').replace(/\/+$/, '');

function readKey() {
  try { return fs.readFileSync(path.join(CONFIG_DIR, 'bilinc.key'), 'utf8').trim() || null; } catch { return process.env.BILINC_API_KEY || null; }
}

async function listRemote(key, prefixFilter, timeoutMs) {
  const out = [];
  let cursor;
  const deadline = Date.now() + timeoutMs;
  for (let page = 0; page < 5; page++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(200, deadline - Date.now()));
    try {
      // Bilinc's list prefix match did not return keys when the prefix ended in ":",
      // so list by the app prefix and filter here.
      const res = await fetch(`${BASE}/api/cloud/memory/list`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 100, values: 'full', prefix: 'sparkguard', ...(cursor ? { cursor } : {}) }),
      });
      if (!res.ok) break;
      const body = await res.json();
      for (const e of body.entries || []) if (String(e.key).startsWith(prefixFilter)) out.push(e);
      cursor = body.nextCursor;
      if (!cursor) break;
    } finally {
      clearTimeout(t);
    }
  }
  return out;
}

async function pull(root, { timeoutMs = 2500 } = {}) {
  const key = readKey();
  if (!key) return { pulled: 0, skipped: 'no-key' };
  const rk = repoKey(root);
  const prefix = `sparkguard:${projectId(rk)}:rule:`;
  const remote = await listRemote(key, prefix, timeoutMs);
  const local = store.active(root);
  let pulled = 0;
  for (const e of remote) {
    const v = e.value || {};
    if (!v.text) continue;
    if (local.some((r) => r.text === v.text)) continue;
    const { created } = store.add({
      text: v.text,
      kind: v.kind || 'deny',
      paths: v.paths || [],
      commands: v.commands || [],
      keywords: v.keywords || [],
      project: rk,
      root,
      said_at: v.said_at,
      tz: v.tz,
      source: 'bilinc',
      extractor: 'bilinc-sync',
      session_id: e.sessionId || null,
    });
    if (created) pulled++;
  }
  return { pulled, remote: remote.length };
}

async function sessionStart(payload) {
  const { projectRoot } = require('./paths');
  const root = projectRoot(payload.cwd);
  try { await pull(root); } catch { /* offline is fine */ }
  try { if (mirror.enabled()) mirror.kick(); } catch { /* ignore */ }
  return {};
}

module.exports = { pull, sessionStart };
