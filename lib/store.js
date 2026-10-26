'use strict';
// Rule store. Rules are the user's own words, kept with where and when they were said.
// Local JSON is the source of truth for the hook path (no network). A remote mirror
// (Bilinc) can be attached later; it never blocks a decision.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_DIR, ensureDir } = require('./paths');

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

function active(project) {
  return load().rules.filter((r) => !r.forgotten && (r.project === project || r.project === '*'));
}

// rule: { text, kind, paths, commands, keywords, project, session_id, source }
function add(rule) {
  const data = load();
  const dup = data.rules.find(
    (r) => !r.forgotten && r.project === rule.project && r.text.trim() === rule.text.trim()
  );
  if (dup) return { rule: dup, created: false };
  const id = `r${data.nextId++}`;
  const stored = {
    id,
    kind: rule.kind || 'deny',
    text: rule.text.trim(),
    paths: rule.paths || [],
    commands: rule.commands || [],
    keywords: rule.keywords || [],
    project: rule.project,
    session_id: rule.session_id || null,
    said_at: rule.said_at || new Date().toISOString(),
    source: rule.source || 'user-prompt',
    extractor: rule.extractor || 'heuristic',
  };
  stored.hash = crypto.createHash('sha256').update(JSON.stringify(stored)).digest('hex').slice(0, 12);
  data.rules.push(stored);
  save(data);
  return { rule: stored, created: true };
}

function forget(id) {
  const data = load();
  const r = data.rules.find((x) => x.id === id && !x.forgotten);
  if (!r) return null;
  r.forgotten = new Date().toISOString();
  save(data);
  return r;
}

module.exports = { load, active, add, forget, RULES_FILE };
