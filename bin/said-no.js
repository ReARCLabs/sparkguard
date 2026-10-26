#!/usr/bin/env node
'use strict';
// said-no CLI: inspect rules and decisions, undo agent file changes.
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const snapshot = require('../lib/snapshot');
const model = require('../lib/model');
const { projectRoot, projectDataDir, repoKey } = require('../lib/paths');
const { fmtDate } = require('../lib/decide');
const capture = require('../lib/capture');

const [cmd, ...args] = process.argv.slice(2);
const root = projectRoot(process.cwd());

function decisions() {
  try {
    return fs.readFileSync(path.join(projectDataDir(root), 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function showRule(r) {
  const scope = [
    r.paths.length ? `paths: ${r.paths.join(', ')}` : null,
    r.commands.length ? `commands: ${r.commands.join(', ')}` : null,
    r.keywords.length ? `keywords: ${r.keywords.join(', ')}` : null,
  ].filter(Boolean).join(' | ');
  return `${r.id}  ${fmtDate(r.said_at, r.tz)}  "${r.text}"\n     ${scope || '(no scope)'}  [source: ${r.source}, session ${String(r.session_id || '-').slice(0, 8)}, via ${r.extractor}]`;
}

async function main() {
  switch (cmd) {
    case 'rules': {
      const rules = args.includes('--all') ? store.load().rules : store.active(root);
      if (!rules.length) { console.log('No rules on record for this project.'); return; }
      console.log(rules.map(showRule).join('\n'));
      return;
    }
    case 'why': {
      const id = args[0];
      const rule = store.active(root).concat(store.load().rules.filter((r) => r.forgotten && (r.project === repoKey(root) || r.project === root))).find((r) => r.id === id);
      if (!rule) { console.log(`No rule ${id}.`); return; }
      console.log(showRule(rule));
      const ds = decisions().filter((d) => d.rule === id);
      console.log(`\n${ds.length} decision(s) for ${id}:`);
      for (const d of ds.slice(-10)) console.log(`  ${d.at}  ${d.decision}${d.path ? ` (${d.path})` : ''}  ${d.summary || ''}${d.ms != null ? `  ${d.ms}ms` : ''}`);
      return;
    }
    case 'add': {
      const sentence = args.join(' ');
      const ex = await capture.extract(sentence);
      if (!ex) { console.log('Not recognised as a rule.'); return; }
      const { rule } = store.add({ text: sentence, paths: ex.paths, commands: ex.commands, keywords: ex.keywords, project: root, source: 'cli', extractor: ex.extractor });
      console.log(showRule(rule));
      return;
    }
    case 'forget': {
      const r = store.forget(args[0], root);
      console.log(r ? `Forgot ${r.id}: "${r.text}"` : `No active rule ${args[0]}.`);
      return;
    }
    case 'steps': {
      const steps = snapshot.readSteps(root);
      if (!steps.length) { console.log('No agent file changes recorded for this project.'); return; }
      for (const s of steps.slice(-15)) console.log(`step ${s.step}  ${s.at}  ${s.tool}  ${s.summary.slice(0, 80)}  (${s.entries.length} path(s))`);
      return;
    }
    case 'undo': {
      const r = snapshot.undo(root, args[0]);
      if (!r.ok) { console.log(r.error); process.exitCode = 1; return; }
      console.log(`Undid step ${r.step} (${r.tool}: ${r.summary.slice(0, 80)})`);
      if (r.restored.length) console.log(`  restored: ${r.restored.join(', ')}`);
      if (r.removed.length) console.log(`  removed (did not exist before): ${r.removed.join(', ')}`);
      if (r.skipped.length) console.log(`  skipped: ${r.skipped.join(', ')}`);
      return;
    }
    case 'decisions': {
      for (const d of decisions().slice(-20)) console.log(JSON.stringify(d));
      return;
    }
    case 'budget': {
      console.log(JSON.stringify(model.budget(), null, 2));
      return;
    }
    case 'reset-project': {
      // Demo helper: drop this project's rules, snapshots and ledger.
      const data = store.load();
      const before = data.rules.length;
      const key = repoKey(root);
      data.rules = data.rules.filter((r) => r.project !== root && r.project !== key);
      fs.writeFileSync(store.RULES_FILE(), JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.rmSync(projectDataDir(root), { recursive: true, force: true });
      console.log(`Reset ${root}: removed ${before - data.rules.length} rule(s), snapshots and decisions.`);
      return;
    }
    default:
      console.log('usage: said-no rules [--all] | why <rule> | add "<sentence>" | forget <rule> | steps | undo [step] | decisions | budget');
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
