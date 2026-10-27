'use strict';
// Muse Spark client for the two model jobs: turning a sentence into a rule, and
// judging a tool call against rules the fast path could not settle.
// Standard mode only (muse-spark-1.3): users' paths and commands are never sent
// to a training-eligible endpoint. Every call is metered against a local budget.
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, ensureDir } = require('./paths');
const { withLock } = require('./lock');

const MODEL = process.env.SPARKGUARD_MODEL || 'muse-spark-1.3';
const BASE = process.env.SPARKGUARD_API_BASE || 'https://api.meta.ai/v1';
// Muse Spark 1.3 Standard, USD per 1M tokens.
const PRICE = { input: 1.25, cached: 0.15, output: 4.25 };

function keyFile() { return path.join(CONFIG_DIR, 'meta.key'); }
function budgetFile() { return path.join(ensureDir(CONFIG_DIR), 'budget.json'); }

function readKey() {
  try { return fs.readFileSync(keyFile(), 'utf8').trim() || null; } catch { return null; }
}

function budget() {
  let text;
  try { text = fs.readFileSync(budgetFile(), 'utf8'); } catch { return { cap_usd: 3, spent_usd: 0, calls: 0 }; }
  // A file that exists but does not parse must not reset the spend: treat it as spent.
  try { return JSON.parse(text); } catch { return { cap_usd: 0, spent_usd: 0, calls: 0, corrupt: true }; }
}

function writeBudget(b) {
  const tmp = `${budgetFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, budgetFile());
}

function record(usage, job, ms) { return withLock(budgetFile(), () => recordUnlocked(usage, job, ms)); }
function recordUnlocked(usage, job, ms) {
  const b = budget();
  if (b.corrupt) return b;
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const input = Math.max(0, (usage?.prompt_tokens || 0) - cached);
  const output = usage?.completion_tokens || 0;
  const cost = (input * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6;
  b.spent_usd = Math.round((b.spent_usd + cost) * 1e6) / 1e6;
  b.calls = (b.calls || 0) + 1;
  b.last = { job, ms, input, cached, output, cost_usd: Math.round(cost * 1e6) / 1e6, at: new Date().toISOString() };
  writeBudget(b);
  return b;
}

// `share` < 1 reserves the rest of the cap: background routing stops at 60%, so the
// referee that guards tool calls never runs out first.
const liveReservations = (b) => (Array.isArray(b.reservations) ? b.reservations.filter((r) => r && Date.now() - r.at < 60000) : []);
const reserved = (b) => liveReservations(b).reduce((n, r) => n + (Number(r.usd) || 0), 0);

function available({ share = 1 } = {}) {
  const b = budget();
  return Boolean(readKey()) && b.spent_usd + reserved(b) < b.cap_usd * share;
}

// One JSON-in/JSON-out call. Returns parsed object or throws.
// timeoutMs is the whole budget, retry included. max_tokens counts reasoning
// tokens too (Muse Spark spends 500-900 even at "minimal"), so callers pass a
// generous cap, and the retry keeps the same effort: a higher effort only
// reasons longer and runs out of room again.
async function askJson(opts) {
  const deadline = Date.now() + (opts.timeoutMs || 6000);
  try {
    return await askOnce(opts);
  } catch (e) {
    const left = deadline - Date.now();
    if (String(e.message) !== 'no-json' || left < 2500) throw e;
    return askOnce({ ...opts, timeoutMs: left });
  }
}

// The answer object, even when the model wraps it in prose or a code fence.
// Tries the whole text, then every balanced {...} span, preferring the last one
// that parses (models put the answer after any reasoning).
function extractJson(text) {
  try { const v = JSON.parse(text.trim()); if (v && typeof v === 'object') return v; } catch { /* not bare JSON */ }
  let found = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let str = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (str) { if (c === '\\') j++; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { found = JSON.parse(text.slice(i, j + 1)); i = j; } catch { /* keep scanning */ }
        break;
      }
    }
  }
  return found && typeof found === 'object' ? found : null;
}

async function askOnce({ system, user, maxTokens = 400, timeoutMs = 6000, job, effort = 'minimal', share = 1 }) {
  const key = readKey();
  if (!key) throw new Error('no-key');
  // Reserve a worst-case cost under the lock before calling, so parallel hooks cannot all
  // pass the cap check at once; record() replaces the reservation with the real cost.
  // A reservation expires after a minute, so a hook killed mid-call cannot leak it.
  const RESERVE = 0.02;
  const rid = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ok = withLock(budgetFile(), () => {
    const b = budget();
    if (b.corrupt || b.spent_usd + reserved(b) >= b.cap_usd * (share || 1)) return false;
    b.reservations = liveReservations(b).concat({ id: rid, usd: RESERVE, at: Date.now() });
    writeBudget(b);
    return true;
  });
  if (!ok) throw new Error('budget-exhausted');
  let settled = false;
  const release = (usage) => {
    if (settled) return;
    settled = true;
    withLock(budgetFile(), () => {
      const b = budget();
      if (b.corrupt) return;
      b.reservations = liveReservations(b).filter((r) => r.id !== rid);
      writeBudget(b);
    });
    if (usage) record(usage.usage, usage.job, usage.ms);
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        reasoning_effort: effort,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    const body = await res.json();
    release(body.usage ? { usage: body.usage, job, ms: Date.now() - t0 } : null);
    if (!res.ok) throw new Error(`api-${res.status}: ${body?.error?.message || ''}`.slice(0, 200));
    const parsed = extractJson(body.choices?.[0]?.message?.content || '');
    if (!parsed) throw new Error('no-json');
    return parsed;
  } finally {
    clearTimeout(timer);
    release(null);
  }
}

module.exports = { askJson, available, budget, readKey, extractJson, MODEL };
