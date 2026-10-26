'use strict';
// UserPromptSubmit: capture rules the user states, and handle "override r4" / "forget rule 4".
// Always returns {} (never blocks a prompt).
const store = require('./store');
const capture = require('./capture');
const { grantOverride, ledger } = require('./decide');
const { projectRoot } = require('./paths');

async function userPromptSubmit(payload, { timeoutMs = 6000 } = {}) {
  const text = String(payload.prompt || '');
  if (!text.trim()) return {};
  const root = projectRoot(payload.cwd);

  const ov = text.match(capture.OVERRIDE);
  if (ov) {
    grantOverride(root, ov[1].toLowerCase());
    ledger(root, { decision: 'override-granted', rule: ov[1].toLowerCase(), session_id: payload.session_id });
  }
  const fg = text.match(capture.FORGET);
  if (fg) {
    const id = fg[1].startsWith('r') ? fg[1] : `r${fg[1]}`;
    const r = store.forget(id);
    if (r) ledger(root, { decision: 'rule-forgotten', rule: id, session_id: payload.session_id });
  }

  const sentences = capture.splitSentences(text).filter((s) => capture.TRIGGER.test(s) && !capture.OVERRIDE.test(s) && !capture.FORGET.test(s));
  for (const sentence of sentences.slice(0, 3)) {
    const ex = await capture.extract(sentence, { timeoutMs });
    if (!ex) continue;
    const { rule, created } = store.add({
      text: sentence,
      kind: 'deny',
      paths: ex.paths,
      commands: ex.commands,
      keywords: ex.keywords,
      project: root,
      session_id: payload.session_id,
      extractor: ex.extractor,
    });
    if (created) ledger(root, { decision: 'rule-recorded', rule: rule.id, extractor: ex.extractor, session_id: payload.session_id });
  }
  return {};
}

module.exports = { userPromptSubmit };
