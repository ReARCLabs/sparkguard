#!/usr/bin/env node
'use strict';
const fs = require('fs');
// Minimal stdio MCP server so the agent can verify a rule's source itself
// (gate test: the agent doubted an unverifiable "you said X on date"),
// and so the user can ask the agent to undo a step.
const path = require('path');
const store = require('../lib/store');
const snapshot = require('../lib/snapshot');
const { projectRoot } = require('../lib/paths');

const TOOLS = [
  {
    name: 'sparkguard_rules',
    description: 'List the standing rules the user stated to Sparkguard for this project, each with the exact sentence, when it was said, and its scope. Read-only. Use this to verify a Sparkguard denial before reporting it to the user.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Absolute path of the current workspace.' } }, required: ['cwd'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Sparkguard rules' },
  },
  {
    name: 'sparkguard_steps',
    description: 'List recent agent file changes Sparkguard snapshotted for this project (step number, tool, summary). Read-only.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Absolute path of the current workspace.' } }, required: ['cwd'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Sparkguard steps' },
  },
  {
    name: 'sparkguard_undo',
    description: 'Restore the files changed by one snapshotted step (default: the latest) to their state before that step. Only call this when the user asks to undo.',
    inputSchema: { type: 'object', properties: { step: { type: 'integer' }, cwd: { type: 'string', description: 'Absolute path of the current workspace.' } }, required: ['cwd'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'Sparkguard undo' },
  },
];

function text(t) { return { content: [{ type: 'text', text: t }] }; }

function call(name, args) {
  // The workspace must be named explicitly; undo never guesses which project it acts on.
  if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd) || !fs.existsSync(args.cwd)) return { ...text('cwd must be the absolute path of the current workspace.'), isError: true };
  const root = projectRoot(args.cwd);
  if (name === 'sparkguard_rules') {
    const rules = store.active(root);
    if (!rules.length) return text(`No Sparkguard rules on record for ${root}.`);
    return text(rules.map((r) => `${r.id} said ${r.said_at} in session ${r.session_id || '-'}: "${r.text}" | paths: ${r.paths.join(', ') || '-'} | commands: ${r.commands.join(', ') || '-'} | source: ${r.source}`).join('\n'));
  }
  if (name === 'sparkguard_steps') {
    const steps = snapshot.readSteps(root).slice(-15);
    if (!steps.length) return text('No snapshotted steps.');
    return text(steps.map((s) => `step ${s.step} ${s.at} ${s.tool} ${s.summary.slice(0, 100)}`).join('\n'));
  }
  if (name === 'sparkguard_undo') {
    const r = snapshot.undo(root, args.step);
    if (!r.ok) return { ...text(r.error), isError: true };
    return text(`Undid step ${r.step} (${r.tool}). Restored: ${r.restored.join(', ') || '-'}. Removed: ${r.removed.join(', ') || '-'}.`);
  }
  return { ...text(`unknown tool ${name}`), isError: true };
}

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function fail(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (id === undefined) continue; // notification
    try {
      if (method === 'initialize') {
        reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sparkguard', version: require(path.join(__dirname, '..', 'package.json')).version } });
      } else if (method === 'tools/list') reply(id, { tools: TOOLS });
      else if (method === 'tools/call') reply(id, call(params.name, params.arguments || {}));
      else if (method === 'ping') reply(id, {});
      else fail(id, -32601, `method not found: ${method}`);
    } catch (e) {
      fail(id, -32603, String(e.message || e));
    }
  }
});
