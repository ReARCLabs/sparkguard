'use strict';
// Rule-capture eval: does a plain-language sentence become the right rule, and
// do ordinary instructions stay ordinary? Runs the real UserPromptSubmit hook
// in throwaway config/data dirs. Usage: node eval/capture.js [--offline] [--heldout | --fresh | --unseen2]
const fs = require('fs');
const os = require('os');
const path = require('path');

const offline = process.argv.includes('--offline');
const set = process.argv.includes('--unseen2') ? 'unseen2' : process.argv.includes('--fresh') ? 'fresh' : process.argv.includes('--heldout') ? 'heldout' : 'cases';
const realConfig = process.env.SPARKGUARD_CONFIG_DIR || path.join(os.homedir(), '.config', 'sparkguard');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkguard-eval-'));
process.env.SPARKGUARD_CONFIG_DIR = path.join(tmp, 'config');
process.env.SPARKGUARD_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.SPARKGUARD_CONFIG_DIR, { recursive: true, mode: 0o700 });
const budgetSrc = path.join(realConfig, 'budget.json');
if (!offline) {
  fs.copyFileSync(path.join(realConfig, 'meta.key'), path.join(process.env.SPARKGUARD_CONFIG_DIR, 'meta.key'));
  if (fs.existsSync(budgetSrc)) fs.copyFileSync(budgetSrc, path.join(process.env.SPARKGUARD_CONFIG_DIR, 'budget.json'));
}

const { userPromptSubmit } = require('../lib/prompt');
const store = require('../lib/store');
const model = require('../lib/model');
const background = require('../lib/background');

const strip = (p) => p.replace(/\*+/g, '').replace(/\/+$/, '').replace(/^\.\//, '').toLowerCase();

function scoped(rule, c) {
  const paths = rule.paths.map(strip);
  const cmds = rule.commands.map((x) => x.toLowerCase());
  const words = [...rule.keywords, rule.about || ''].join(' ').toLowerCase();
  const okPaths = (c.paths || []).every((p) => paths.some((q) => q === strip(p) || q.startsWith(`${strip(p)}/`)));
  const okCmds = (c.commands || []).every((x) => cmds.some((y) => y.startsWith(x.toLowerCase()) || x.toLowerCase().startsWith(y)));
  const okWords = (c.keywords || []).every((k) => words.includes(k.toLowerCase()) || paths.some((q) => q.includes(k.toLowerCase())));
  return okPaths && okCmds && okWords;
}

(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, `capture-${set}.json`), 'utf8'));
  const spentBefore = model.budget().spent_usd;
  const rows = [];
  let i = 0;
  for (const c of cases) {
    const cwd = fs.mkdtempSync(path.join(tmp, `case${++i}-`));
    const t0 = Date.now();
    const out = await userPromptSubmit({ prompt: c.text, cwd, session_id: `eval-${i}` }, { timeoutMs: 15000 });
    const ms = Date.now() - t0;
    // Background-routed prompts: wait for the detached router (it removes its marker).
    while (background.pendingFor(cwd, `eval-${i}`).length && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
    const activeMs = Date.now() - t0;
    const rule = store.active(cwd)[0] || null;
    const got = !!rule;
    const tier = !rule ? null : rule.extractor === 'background' ? 'background' : 'sync';
    rows.push({ i, text: c.text, expected: c.rule, got, tier, scoped: got && c.rule ? scoped(rule, c) : null, ms, active_ms: activeMs,
      rule: rule && { paths: rule.paths, commands: rule.commands, keywords: rule.keywords, about: rule.about, via: rule.extractor },
      said: out.systemMessage || null });
    process.stderr.write(`${got === c.rule ? '.' : 'x'}`);
  }
  process.stderr.write('\n');
  const tp = rows.filter((r) => r.expected && r.got).length;
  const fp = rows.filter((r) => !r.expected && r.got).length;
  const fn = rows.filter((r) => r.expected && !r.got).length;
  const scopedOk = rows.filter((r) => r.scoped).length;
  const spent = model.budget().spent_usd - spentBefore;
  const summary = {
    mode: offline ? 'offline heuristic' : model.MODEL,
    set,
    cases: rows.length,
    precision: +(tp / Math.max(1, tp + fp)).toFixed(3),
    recall: +(tp / Math.max(1, tp + fn)).toFixed(3),
    scope_correct_of_captured: `${scopedOk}/${tp}`,
    false_positives: fp,
    median_ms: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    captured_sync: rows.filter((r) => r.got && r.tier === 'sync').length,
    captured_background: rows.filter((r) => r.got && r.tier === 'background').length,
    background_active_ms_median: (() => { const b = rows.filter((r) => r.tier === 'background').map((r) => r.active_ms).sort((a, b) => a - b); return b.length ? b[Math.floor(b.length / 2)] : null; })(),
    spent_usd: +spent.toFixed(4),
  };
  // Keep the real spend cap honest.
  if (!offline && spent > 0 && fs.existsSync(budgetSrc)) {
    const b = JSON.parse(fs.readFileSync(budgetSrc, 'utf8'));
    b.spent_usd = +(b.spent_usd + spent).toFixed(6);
    fs.writeFileSync(budgetSrc, JSON.stringify(b, null, 2));
  }
  const file = path.join(__dirname, 'results', `capture-${set}-${offline ? 'offline' : 'model'}${process.env.EVAL_TAG ? `-${process.env.EVAL_TAG}` : ''}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows.filter((x) => x.got !== x.expected || x.scoped === false)) {
    console.log(`${r.expected ? (r.got ? 'SCOPE' : 'MISS') : 'FALSE+'}  ${r.text}  ${r.rule ? JSON.stringify(r.rule) : ''}`);
  }
})();
