'use strict';
// Rule capture from the user's own prompt. Only UserPromptSubmit text is ever a
// source: never tool output or file contents, so a file cannot plant a rule.
const model = require('./model');

// Cheap gate before any model call. English plus a few Turkish forms.
const TRIGGER = /\b(never|don'?t|do not|must not|mustn'?t|shouldn'?t|should not|without asking|ask me (first|before)|always ask|leave .* alone|hands off|off[- ]limits|keep .* as is|stay on|we (stay|keep|use)|asla|dokunma|silme|değiştirme|elleme|sormadan)\b/i;

// Prompts that look like overrides, not new rules.
const OVERRIDE = /\boverride\s+(r\d+)\b/i;
const FORGET = /\bforget rule\s+(r?\d+)\b/i;

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Heuristic extraction used when the model is unavailable (no key, budget, timeout).
// Pulls path-like and code-like tokens out of a "never touch X" sentence.
function heuristic(sentence) {
  const paths = new Set();
  const commands = new Set();
  const quoted = [...sentence.matchAll(/[`"']([^`"']{2,120})[`"']/g)].map((m) => m[1]);
  const words = sentence.split(/\s+/).map((w) => w.replace(/^[(`"']+|[)`"',.;:!?]+$/g, ''));
  for (const w of [...quoted, ...words]) {
    if (!w) continue;
    if (/^(git|npm|npx|yarn|pnpm|docker|kubectl|terraform|prisma|rm|drop)\b/i.test(w) && w.includes(' ')) commands.add(w);
    else if (/[\w*.-]+\/[\w*./-]*|^\.?[\w-]+\.(env|sql|json|ya?ml|toml|lock|key|pem)$|^\.env/.test(w)) paths.add(w.replace(/\/+$/, ''));
  }
  const m = sentence.match(/\b(git push --force|git push -f|npm publish|drop table|drop database|terraform destroy|kubectl delete|prisma migrate reset)\b/i);
  if (m) commands.add(m[1]);
  return { paths: [...paths], commands: [...commands], keywords: [] };
}

const SYSTEM = `You turn one sentence a developer said to their coding agent into an enforceable rule, or decide it is not a rule.
A rule is a standing instruction that forbids or gates an action on specific files, directories, commands or systems ("never touch prisma/migrations", "don't push to main", "ask me before deleting anything in data/").
Not rules: one-off task instructions, preferences about style, things already done, questions, hypotheticals, relaxations ("don't worry about tests").
Return JSON only:
{"is_rule": boolean, "confidence": 0..1, "paths": [project-relative paths or globs], "commands": [exact command prefixes], "keywords": [short nouns that identify the protected thing when no path is given]}
Use [] for empty lists. Never invent paths that are not in the sentence.`;

async function extract(sentence, { timeoutMs = 6000 } = {}) {
  if (model.available()) {
    try {
      const r = await model.askJson({ system: SYSTEM, user: sentence, maxTokens: 700, timeoutMs, job: 'capture' });
      if (r && r.is_rule && (r.confidence ?? 0) >= 0.7) {
        const clean = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
        const out = { paths: clean(r.paths), commands: clean(r.commands), keywords: clean(r.keywords), confidence: r.confidence, extractor: model.MODEL };
        if (out.paths.length || out.commands.length || out.keywords.length) return out;
      }
      if (r && r.is_rule === false) return null;
    } catch {
      // fall through to the heuristic
    }
  }
  const h = heuristic(sentence);
  if (h.paths.length || h.commands.length) return { ...h, confidence: 0.6, extractor: 'heuristic' };
  return null;
}

module.exports = { TRIGGER, OVERRIDE, FORGET, splitSentences, heuristic, extract };
