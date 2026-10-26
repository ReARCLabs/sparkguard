'use strict';
// Offline tests: no API key is visible, so every path here is deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'said-no-test-'));
process.env.SAID_NO_CONFIG_DIR = path.join(tmp, 'config');
process.env.SAID_NO_DATA_DIR = path.join(tmp, 'data');

const match = require('../lib/match');
const capture = require('../lib/capture');
const store = require('../lib/store');
const snapshot = require('../lib/snapshot');
const { preToolUse } = require('../lib/decide');
const { userPromptSubmit } = require('../lib/prompt');

const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, 'prisma', 'migrations'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'prisma', 'migrations', '0001_init.sql'), 'CREATE TABLE customers (id int);\n');
fs.writeFileSync(path.join(repo, 'src', 'math.js'), 'return a - b;\n');

const pre = (tool, input) => preToolUse({ tool_name: tool, tool_input: input, cwd: repo, session_id: 's-test', tool_use_id: `t${Math.random()}` });
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('shell analysis: read-only vs mutating', () => {
  const ro = match.normalize({ tool_name: 'bash', tool_input: { command: 'ls -la prisma/migrations && cat prisma/migrations/0001_init.sql' }, cwd: repo });
  assert.strictEqual(ro.mutating, false);
  const rm = match.normalize({ tool_name: 'bash', tool_input: { command: 'rm -rf prisma/migrations' }, cwd: repo });
  assert.strictEqual(rm.mutating, true);
  assert.deepStrictEqual(rm.paths, [path.join(repo, 'prisma/migrations')]);
  const redirect = match.normalize({ tool_name: 'bash', tool_input: { command: 'echo x > prisma/migrations/0002.sql' }, cwd: repo });
  assert.strictEqual(redirect.mutating, true);
  const sed = match.normalize({ tool_name: 'bash', tool_input: { command: "sed -i '' 's/a/b/' prisma/migrations/0001_init.sql" }, cwd: repo });
  assert.strictEqual(sed.mutating, true);
  const gitStatus = match.normalize({ tool_name: 'bash', tool_input: { command: 'git status && git diff' }, cwd: repo });
  assert.strictEqual(gitStatus.mutating, false);
});

test('ignored tools: reads and Muse internals', () => {
  for (const t of ['read_file', 'read_memory', 'submit_reminder_decision', 'list_directory', 'grep']) {
    assert.strictEqual(match.normalize({ tool_name: t, tool_input: { path: 'prisma/migrations/0001_init.sql' }, cwd: repo }), null, t);
  }
});

test('path matching: dir, glob, bare name', () => {
  const f = path.join(repo, 'prisma/migrations/0001_init.sql');
  assert.ok(match.pathMatches(f, 'prisma/migrations', repo));
  assert.ok(match.pathMatches(f, 'prisma/migrations/', repo));
  assert.ok(match.pathMatches(f, 'prisma/**/*.sql', repo));
  assert.ok(match.pathMatches(f, 'migrations', repo));
  assert.ok(!match.pathMatches(path.join(repo, 'src/math.js'), 'prisma/migrations', repo));
  assert.ok(match.pathMatches(path.join(repo, '.env'), '.env', repo));
});

test('heuristic capture pulls paths and commands from a sentence', () => {
  assert.ok(capture.TRIGGER.test('Never touch prisma/migrations, ask me first.'));
  assert.ok(!capture.TRIGGER.test('Fix the bug in src/math.js'));
  assert.ok(capture.TRIGGER.test('prisma klasörüne asla dokunma'));
  const h = capture.heuristic('Never touch prisma/migrations, ask me first.');
  assert.deepStrictEqual(h.paths, ['prisma/migrations']);
  const c = capture.heuristic("Don't ever run git push --force on this repo.");
  assert.ok(c.commands.includes('git push --force'));
});

test('end to end without a model: capture, deny with citation, allow + snapshot, undo', async () => {
  await userPromptSubmit({ prompt: 'Never touch prisma/migrations, ask me first. Then fix the bug.', cwd: repo, session_id: 's-1' });
  const rules = store.active(repo);
  assert.strictEqual(rules.length, 1);
  assert.deepStrictEqual(rules[0].paths, ['prisma/migrations']);

  const d1 = await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'id int', replace: 'id int, email text' });
  assert.ok(denied(d1));
  const reason = d1.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /you said "Never touch prisma\/migrations, ask me first\."/);
  assert.match(reason, /rule r1/);
  assert.match(reason, /said_no_rules/);

  assert.ok(denied(await pre('bash', { command: 'rm prisma/migrations/0001_init.sql' })));
  assert.deepStrictEqual(await pre('bash', { command: 'ls prisma/migrations' }), {});
  assert.deepStrictEqual(await pre('read_file', { path: 'prisma/migrations/0001_init.sql' }), {});

  // allowed edit is snapshotted and can be undone
  assert.deepStrictEqual(await pre('edit_file', { path: 'src/math.js', find: 'a - b', replace: 'a + b' }), {});
  fs.writeFileSync(path.join(repo, 'src', 'math.js'), 'return a + b;\n');
  // a brand-new file is recorded as absent, so undo removes it
  assert.deepStrictEqual(await pre('write_file', { path: 'src/new.js', content: 'x' }), {});
  fs.writeFileSync(path.join(repo, 'src', 'new.js'), 'x');

  const u2 = snapshot.undo(repo);
  assert.deepStrictEqual(u2.removed, ['src/new.js']);
  assert.ok(!fs.existsSync(path.join(repo, 'src', 'new.js')));
  const steps = snapshot.readSteps(repo);
  const u1 = snapshot.undo(repo, steps[steps.length - 2].step);
  assert.deepStrictEqual(u1.restored, ['src/math.js']);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), 'return a - b;\n');
});

test('override once, then the rule applies again; forget removes it', async () => {
  await userPromptSubmit({ prompt: 'override r1', cwd: repo, session_id: 's-2' });
  assert.deepStrictEqual(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' }), {});
  assert.ok(denied(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' })));
  await userPromptSubmit({ prompt: 'forget rule 1', cwd: repo, session_id: 's-2' });
  assert.deepStrictEqual(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' }), {});
});

test('rules are per project', async () => {
  const other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  await userPromptSubmit({ prompt: "Don't touch config/ ever.", cwd: other, session_id: 's-3' });
  assert.strictEqual(store.active(other).length, 1);
  assert.strictEqual(store.active(repo).length, 0);
});
