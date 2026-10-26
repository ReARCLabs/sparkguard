'use strict';
// Muse Spark client for the two model jobs: turning a sentence into a rule, and
// judging a tool call against rules the fast path could not settle.
// Standard mode only (muse-spark-1.3): users' paths and commands are never sent
// to a training-eligible endpoint. Every call is metered against a local budget.
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, ensureDir } = require('./paths');

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
  try { return JSON.parse(fs.readFileSync(budgetFile(), 'utf8')); } catch { return { cap_usd: 3, spent_usd: 0, calls: 0 }; }
}

function record(usage, job, ms) {
  const b = budget();
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const input = Math.max(0, (usage?.prompt_tokens || 0) - cached);
  const output = usage?.completion_tokens || 0;
  const cost = (input * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6;
  b.spent_usd = Math.round((b.spent_usd + cost) * 1e6) / 1e6;
  b.calls = (b.calls || 0) + 1;
  b.last = { job, ms, input, cached, output, cost_usd: Math.round(cost * 1e6) / 1e6, at: new Date().toISOString() };
  fs.writeFileSync(budgetFile(), JSON.stringify(b, null, 2));
  return b;
}

function available() {
  const b = budget();
  return Boolean(readKey()) && b.spent_usd < b.cap_usd;
}

// One JSON-in/JSON-out call. Returns parsed object or throws.
async function askJson(opts) {
  // One retry when the model answers without parseable JSON (seen with minimal effort).
  try {
    return await askOnce(opts);
  } catch (e) {
    if (String(e.message) !== 'no-json') throw e;
    return askOnce({ ...opts, effort: 'low' });
  }
}

async function askOnce({ system, user, maxTokens = 400, timeoutMs = 6000, job, effort = 'minimal' }) {
  const key = readKey();
  if (!key) throw new Error('no-key');
  const b = budget();
  if (b.spent_usd >= b.cap_usd) throw new Error('budget-exhausted');
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
    if (body.usage) record(body.usage, job, Date.now() - t0);
    if (!res.ok) throw new Error(`api-${res.status}: ${body?.error?.message || ''}`.slice(0, 200));
    const text = body.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no-json');
    return JSON.parse(m[0]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askJson, available, budget, readKey, MODEL };
