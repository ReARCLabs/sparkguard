'use strict';
// Rule store. Rules are the user's own words, kept with where and when they were said.
// Local JSON is the source of truth for the hook path (no network). A remote mirror
// (Bilinc) can be attached later; it never blocks a decision.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_DIR, ensureDir, repoKey } = require('./paths');

const RULES_FILE = () => path.join(ensureDir(CONFIG_DIR), 'rules.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(RULES_FILE(), 'utf8'));
    return Array.isArray(data.rules) ? data : { version: 1, nextId: 1, rules: [] };
  } catch {
    return { version: 1, nextId: 1, rules: [] };
  }
}

function save(data) {
  const file = RULES_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// `root` is a checkout path; rules are matched by repository identity, so every
// clone of the same repo shares them.
function active(root) {
  const key = repoKey(root);
  return load().rules.filter((r) => !r.forgotten && (r.project === key || r.project === root || r.project === '*'));
}

// rule: { text, kind, paths, commands, keywords, project, session_id, source }
function add(input) {
  const rule = { ...input, root: input.root || input.project, project: input.project && !String(input.project).includes(':') ? repoKey(input.project) : input.project };
  const data = load();
  const dup = data.rules.find(
    (r) => !r.forgotten && r.project === rule.project && r.text.trim() === rule.text.trim()
  );
  if (dup) return { rule: dup, created: false };
  // ids are per project ("r1" is the first rule in this repo), unique within it
  const used = data.rules.filter((r) => r.project === rule.project).map((r) => Number(String(r.id).slice(1)) || 0);
  const id = `r${(used.length ? Math.max(...used) : 0) + 1}`;
  const stored = {
    id,
    kind: rule.kind || 'deny',
    text: rule.text.trim(),
    about: rule.about || null,
    paths: rule.paths || [],
    commands: rule.commands || [],
    keywords: rule.keywords || [],
    project: rule.project,
    root: rule.root,
    session_id: rule.session_id || null,
    said_at: rule.said_at || new Date().toISOString(),
    tz: rule.tz || process.env.SPARKGUARD_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    source: rule.source || 'user-prompt',
    extractor: rule.extractor || 'heuristic',
  };
  stored.hash = crypto.createHash('sha256').update(JSON.stringify(stored)).digest('hex').slice(0, 12);
  data.rules.push(stored);
  save(data);
  return { rule: stored, created: true };
}

function forget(id, root) {
  const data = load();
  const key = root ? repoKey(root) : null;
  const r = data.rules.find((x) => x.id === id && !x.forgotten && (!root || x.project === key || x.project === root));
  if (!r) return null;
  r.forgotten = new Date().toISOString();
  save(data);
  return r;
}

module.exports = { load, active, add, forget, RULES_FILE };
