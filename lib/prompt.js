'use strict';
// UserPromptSubmit: understand plain-language rules, consent and withdrawals.
// Never blocks a prompt. When it acts, it adds one line of context so the agent
// can tell the user what Sparkguard did.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const intent = require('./intent');
const capture = require('./capture');
const session = require('./session');
const model = require('./model');
const mirror = require('./mirror');
const { grantOverride, ledger } = require('./decide');
const background = require('./background');
const { projectRoot, projectDataDir } = require('./paths');

// Verbs and filler the model sometimes returns as "keywords"; they would match everything.
const GENERIC_WORDS = /^(delete[ds]?|deleting|remove[ds]?|removing|touch(ed|ing)?|edit(s|ed|ing)?|change[ds]?|modif(y|ied)|write|run|push(ed)?|files?|folders?|director(y|ies)|anything|everything|it|this|that|these|those|stuff|data|code)$/i;

function lastBlock(root, sessionId) {
  try {
    const rows = fs.readFileSync(path.join(projectDataDir(root), 'decisions.jsonl'), 'utf8').trim().split('\n').slice(-200);
    for (let i = rows.length - 1; i >= 0; i--) {
      const d = JSON.parse(rows[i]);
      if (d.session_id === sessionId && d.decision === 'deny' && d.rule) {
        return { rule: d.rule, summary: d.summary, minutesAgo: Math.round((Date.now() - Date.parse(d.at)) / 60000) };
      }
    }
  } catch { /* no ledger yet */ }
  return null;
}

function context(lines) {
  if (!lines.length) return {};
  return {
    // Shown to the user directly where the host supports it (Claude-compatible field).
    systemMessage: lines.map((l) => l.replace(/ It will block.*$| The rule stays.*$/, '')).join(' '),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${lines.join('\n')}\nStart your reply to the user with one short line saying what Sparkguard just did (for example "Sparkguard: noted, logs/ is protected."), then answer the rest of their message. Only attribute something to Sparkguard when Sparkguard reports it like this or blocks a tool call; if you decline something yourself, say it is your own decision.`,
    },
  };
}

// Store an add_rule action as a rule, keeping the user's own words. Returns the new
// rule, or null when it is malformed, too vague or already known.
function recordRule(a, { text, root, sid, routedBy }) {
  const clean = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : []);
  let paths = clean(a.paths);
  const commands = clean(a.commands);
  // The model sometimes understands the rule but leaves the scope empty; recover
  // explicit paths from the user's own sentence rather than drop the rule.
  if (!paths.length && !commands.length) paths = capture.heuristic(a.sentence || text).paths;
  const keywords = clean(a.keywords).filter((k) => !GENERIC_WORDS.test(k) && !paths.some((p) => p.toLowerCase().includes(k.toLowerCase())));
  if (!paths.length && !commands.length && !keywords.length) return null;
  // The rule is quoted back later, so keep the user's own words.
  const sentence = a.sentence && text.includes(a.sentence.trim()) ? a.sentence.trim() : text.slice(0, 300);
  const { rule, created } = store.add({
    text: sentence,
    about: typeof a.about === 'string' ? a.about.replace(/^\s*(protects|protecting)\s+/i, '').slice(0, 120) : null,
    kind: 'deny',
    paths, commands, keywords,
    project: root,
    session_id: sid,
    extractor: a.extractor || routedBy,
  });
  if (!created) return null;
  ledger(root, { decision: 'rule-recorded', rule: rule.id, extractor: rule.extractor, session_id: sid, via: routedBy });
  if (mirror.enqueue(mirror.ruleItem(rule))) mirror.kick();
  return rule;
}

async function userPromptSubmit(payload, { timeoutMs = 7000 } = {}) {
  const text = String(payload.prompt || '').trim();
  if (!text) return {};
  const root = projectRoot(payload.cwd);
  const sid = payload.session_id;
  const rules = store.active(root);
  const block = lastBlock(root, sid);
  const recap = session.recap(root, sid);
  session.recordPrompt(root, sid, text);

  // Rules the background router recorded from earlier messages, not yet mentioned.
  const earlier = background.takeAnnouncements(root, sid).map((r) => `Sparkguard recorded rule ${r.id} from an earlier message: "${r.text}". It blocks any tool call that breaks it.`);

  // The floors read the unquoted, normalised text; rules keep the user's own words.
  const said0 = intent.unquoted(text);
  const g = intent.gates(said0);
  const replyToBlock = block && block.minutesAgo <= 30 && text.length <= 120;
  if (!g.rule && !g.consent && !g.forget && !replyToBlock) {
    // Softer rule language, or a message that names a file or folder in the repo:
    // route it in the background so the prompt is not delayed. Adds rules only.
    if (background.wanted(text, root)) background.enqueue(root, sid, text);
    return context(earlier);
  }

  let actions = [];
  let routedBy = 'heuristic';
  let routeError = null;
  const t0 = Date.now();
  if (model.available()) {
    try {
      actions = await intent.route(text, { rules, recap, lastBlock: block, root, timeoutMs });
      routedBy = model.MODEL;
    } catch (e) {
      routeError = String(e && e.message || e).slice(0, 80);
      actions = intent.fallback(text, { rules, lastBlock: block });
    }
  } else {
    actions = intent.fallback(text, { rules, lastBlock: block });
  }
  // One row per routed prompt, so a missed rule can be explained later (no prompt text stored).
  ledger(root, { decision: 'prompt-routed', via: routedBy, error: routeError, ms: Date.now() - t0, session_id: sid,
    actions: actions.map((a) => ({ type: a.type, confidence: a.confidence, paths: a.paths, commands: a.commands, keywords: a.keywords })) });

  // Widening needs a plain yes, whatever the model thinks: a deterministic floor.
  const opening = intent.firstSentence(said0);
  const saysYes = (intent.CONSENT.test(opening) || /\b(sure|yes|yep|yeah|ok(ay)?|fine|alright|please do|approved?)\b/i.test(opening)) && !/^\s*ok(ay)?,? thanks?\b/i.test(opening) && !intent.NOT_YES.test(said0);
  const said = [];
  for (const a of actions) {
    const conf = a.confidence ?? 0;
    // The offline heuristic only fires on explicit paths/commands, so it gets a lower bar.
    if (a.type === 'add_rule' && conf >= (a.extractor === 'heuristic' ? 0.5 : 0.7)) {
      const rule = recordRule(a, { text, root, sid, routedBy });
      if (rule) said.push(`Sparkguard recorded rule ${rule.id}: "${rule.text}"${rule.about ? ` (protects ${rule.about})` : ''}. It will block any tool call that breaks it, in this and future sessions.`);
    } else if (a.type === 'allow_once' && conf >= 0.8 && saysYes) {
      const rule = rules.find((r) => r.id === a.rule_id);
      if (!rule) continue;
      const answersBlock = block && block.rule === rule.id && block.minutesAgo <= 60;
      const named = new RegExp(`\\b${rule.id}\\b`, 'i').test(text) || rule.paths.some((p) => intent.mentionsPath(text, p));
      if (!answersBlock && !named) continue;
      grantOverride(root, rule.id, sid);
      ledger(root, { decision: 'override-granted', rule: rule.id, session_id: sid, via: routedBy });
      said.push(`Sparkguard will allow one call that breaks rule ${rule.id} ("${rule.text}"), because the user just said so. The rule stays in place after that.`);
    } else if (a.type === 'forget_rule' && conf >= 0.85 && (g.forget || /\bforget rule\b/i.test(said0)) && !intent.NOT_YES.test(said0)) {
      const r = store.forget(a.rule_id, root);
      if (!r) continue;
      ledger(root, { decision: 'rule-forgotten', rule: r.id, session_id: sid, via: routedBy });
      if (mirror.enqueue(mirror.forgetItem(r))) mirror.kick();
      said.push(`Sparkguard removed rule ${r.id} ("${r.text}") at the user's request.`);
    }
  }
  return context([...earlier, ...said]);
}

module.exports = { userPromptSubmit, recordRule, lastBlock };
