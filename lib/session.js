'use strict';
// A small per-session recap kept by Sparkguard's own hooks, so plain-language
// prompts can be resolved ("never delete this" -> what was just being discussed).
// It does not depend on Muse Code's internal transcript format.
const fs = require('fs');
const path = require('path');
const { projectDataDir } = require('./paths');

const MAX_PROMPTS = 5;
const MAX_TOOLS = 12;

function file(root, sessionId) {
  const dir = path.join(projectDataDir(root), 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${String(sessionId || 'none').replace(/[^\w.-]/g, '_')}.json`);
}

function load(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(file(root, sessionId), 'utf8')); } catch { return { prompts: [], tools: [], assistant: null }; }
}

function save(root, sessionId, s) {
  try { fs.writeFileSync(file(root, sessionId), JSON.stringify(s), { mode: 0o600 }); } catch { /* recap is best effort */ }
}

function recordPrompt(root, sessionId, text) {
  const s = load(root, sessionId);
  s.prompts.push({ at: new Date().toISOString(), text: String(text).slice(0, 1500) });
  s.prompts = s.prompts.slice(-MAX_PROMPTS);
  save(root, sessionId, s);
}

function recordTool(root, sessionId, entry) {
  const s = load(root, sessionId);
  s.tools.push({ at: new Date().toISOString(), ...entry });
  s.tools = s.tools.slice(-MAX_TOOLS);
  save(root, sessionId, s);
}

function recordAssistant(root, sessionId, text) {
  if (!text) return;
  const s = load(root, sessionId);
  s.assistant = { at: new Date().toISOString(), text: String(text).slice(0, 2000) };
  save(root, sessionId, s);
}

// Plain-text recap for the model. Everything in it is data, never instructions.
function recap(root, sessionId) {
  const s = load(root, sessionId);
  const lines = [];
  if (s.prompts.length) lines.push('Earlier user messages (oldest first):', ...s.prompts.map((p) => `- ${p.text}`));
  if (s.assistant) lines.push('Agent\'s last reply:', s.assistant.text);
  if (s.tools.length) lines.push('Recent tool calls:', ...s.tools.map((t) => `- ${t.tool}: ${t.summary}`));
  return lines.join('\n');
}

module.exports = { load, recordPrompt, recordTool, recordAssistant, recap };
