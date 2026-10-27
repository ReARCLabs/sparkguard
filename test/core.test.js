'use strict';
// Offline tests: no API key is visible, so every path here is deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkguard-test-'));
process.env.SPARKGUARD_CONFIG_DIR = path.join(tmp, 'config');
process.env.SPARKGUARD_DATA_DIR = path.join(tmp, 'data');

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
  assert.match(reason, /the user said "Never touch prisma\/migrations, ask me first\."/);
  assert.match(reason, /rule r1/);
  assert.match(reason, /sparkguard_rules/);

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
  // a yes said in another chat does not unlock this one
  await userPromptSubmit({ prompt: 'override r1', cwd: repo, session_id: 's-other' });
  assert.ok(denied(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' })));
  await userPromptSubmit({ prompt: 'override r1', cwd: repo, session_id: 's-test' });
  assert.deepStrictEqual(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' }), {});
  assert.ok(denied(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' })));
  await userPromptSubmit({ prompt: "Don't forget rule 1, it still applies.", cwd: repo, session_id: 's-test' });
  assert.ok(denied(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' })), "don't forget keeps the rule");
  await userPromptSubmit({ prompt: 'forget rule 1', cwd: repo, session_id: 's-test' });
  assert.deepStrictEqual(await pre('edit_file', { path: 'prisma/migrations/0001_init.sql', find: 'a', replace: 'b' }), {});
});

test('rules are per project', async () => {
  const other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  await userPromptSubmit({ prompt: "Don't touch config/ ever.", cwd: other, session_id: 's-3' });
  assert.strictEqual(store.active(other).length, 1);
  assert.strictEqual(store.active(repo).length, 0);
});

test('a clone of the same repo shares rules (root-commit identity)', async () => {
  const { execFileSync } = require('child_process');
  const a = path.join(tmp, 'orig');
  fs.mkdirSync(path.join(a, 'data'), { recursive: true });
  fs.writeFileSync(path.join(a, 'data', 'clients.csv'), 'x\n');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(a, 'init', '-q');
  git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const b = path.join(tmp, 'clone');
  git(tmp, 'clone', '-q', a, b);
  await userPromptSubmit({ prompt: 'Never delete anything in data/.', cwd: a, session_id: 's-a' });
  const r = await preToolUse({ tool_name: 'bash', tool_input: { command: 'rm data/clients.csv' }, cwd: b, session_id: 's-b', tool_use_id: 'x' });
  assert.ok(denied(r), 'rule said in the original checkout applies in the clone');
});

test('plain-language consent right after a block allows exactly one call (offline)', async () => {
  const r3 = path.join(tmp, 'consent');
  fs.mkdirSync(path.join(r3, '.git'), { recursive: true });
  fs.mkdirSync(path.join(r3, 'data', 'exports'), { recursive: true });
  fs.writeFileSync(path.join(r3, 'data', 'exports', 'q1.csv'), 'x');
  const call = () => preToolUse({ tool_name: 'bash', tool_input: { command: 'rm -rf data/exports' }, cwd: r3, session_id: 's-c', tool_use_id: `t${Math.random()}` });
  await userPromptSubmit({ prompt: 'Never delete anything in data/exports.', cwd: r3, session_id: 's-c' });
  assert.ok(denied(await call()));
  const out = await userPromptSubmit({ prompt: 'ok, go ahead this once', cwd: r3, session_id: 's-c' });
  assert.match(out.hookSpecificOutput.additionalContext, /allow one call/);
  assert.deepStrictEqual(await call(), {});
  assert.ok(denied(await call()), 'only once');
  // consent in a different session, with no block there, grants nothing
  await userPromptSubmit({ prompt: 'go ahead this once', cwd: r3, session_id: 's-other' });
  assert.ok(denied(await preToolUse({ tool_name: 'bash', tool_input: { command: 'rm -rf data/exports' }, cwd: r3, session_id: 's-other', tool_use_id: 'z' })));
});

test('mv snapshots both source and destination, undo restores the source', async () => {
  const r4 = path.join(tmp, 'mv');
  fs.mkdirSync(path.join(r4, '.git'), { recursive: true });
  fs.writeFileSync(path.join(r4, 'a.txt'), 'A');
  assert.deepStrictEqual(await preToolUse({ tool_name: 'bash', tool_input: { command: 'mv a.txt b.txt' }, cwd: r4, session_id: 's-m', tool_use_id: 'm1' }), {});
  fs.renameSync(path.join(r4, 'a.txt'), path.join(r4, 'b.txt'));
  const u = snapshot.undo(r4);
  assert.deepStrictEqual(u.restored, ['a.txt']);
  assert.deepStrictEqual(u.removed, ['b.txt']);
  assert.strictEqual(fs.readFileSync(path.join(r4, 'a.txt'), 'utf8'), 'A');
});

test('bypass routes: inline code, nested shell and MCP writes are guarded (offline)', async () => {
  const r5 = path.join(tmp, 'bypass');
  fs.mkdirSync(path.join(r5, '.git'), { recursive: true });
  fs.mkdirSync(path.join(r5, 'data', 'exports'), { recursive: true });
  await userPromptSubmit({ prompt: 'Never delete anything in data/exports.', cwd: r5, session_id: 's-b' });
  const run = (tool, input) => preToolUse({ tool_name: tool, tool_input: input, cwd: r5, session_id: 's-b', tool_use_id: `b${Math.random()}` });
  for (const c of [
    "python3 -c \"import shutil; shutil.rmtree('data/exports')\"",
    "node -e \"require('fs').rmSync('data/exports',{recursive:true})\"",
    "bash -c 'rm -rf data/exports'",
    "sh -c \"find data/exports -delete\"",
  ]) assert.ok(denied(await run('bash', { command: c })), c);
  assert.ok(denied(await run('mcp__fs__delete_file', { path: 'data/exports/q1.csv' })), 'mcp delete');
  // harmless code and reads stay allowed
  assert.deepStrictEqual(await run('bash', { command: "python3 -c \"print(len(open('data/exports/q1.csv').read()))\"" }), {});
  assert.deepStrictEqual(await run('bash', { command: "node -e \"console.log(1+1)\"" }), {});
  assert.deepStrictEqual(await run('mcp__fs__read_file', { path: 'data/exports/q1.csv' }), {});
});

test('deleting a parent, cd, xargs, globs and git clean are guarded; copies out are not (offline)', async () => {
  const r6 = path.join(tmp, 'parents');
  fs.mkdirSync(path.join(r6, '.git'), { recursive: true });
  fs.mkdirSync(path.join(r6, 'data', 'exports'), { recursive: true });
  fs.mkdirSync(path.join(r6, 'tmp'), { recursive: true });
  await userPromptSubmit({ prompt: 'Never delete anything in data/exports.', cwd: r6, session_id: 's-p' });
  const run = (command) => preToolUse({ tool_name: 'bash', tool_input: { command }, cwd: r6, session_id: 's-p', tool_use_id: `p${Math.random()}` });
  for (const c of [
    'rm -rf data',
    'rm -rf .',
    'rm -rf data/ex*',
    'cd data && rm -rf exports',
    "sh -c 'cd data; rm -rf exports'",
    "find data -name '*.csv' -delete",
    'git clean -fdx',
    'ls data/exports | xargs -I{} rm data/exports/{}',
    'tar czf x.tgz data/exports --remove-files',
    'mv data /tmp/old-data',
    'rm -rf "$PWD/data/exports"',
  ]) assert.ok(denied(await run(c)), c);
  for (const c of [
    'cp data/exports/q1.csv /tmp/backup.csv',
    'rm -rf tmp',
    'git clean -fd tmp',
    'mkdir -p data/new',
    'rm -rf data/other',
    'tar czf /tmp/backup.tgz data/exports',
  ]) assert.deepStrictEqual(await run(c), {}, c);
});

test('a one-time yes that names the protected path works before any block (offline)', async () => {
  const r7 = path.join(tmp, 'early-consent');
  fs.mkdirSync(path.join(r7, '.git'), { recursive: true });
  fs.mkdirSync(path.join(r7, 'data', 'exports'), { recursive: true });
  await userPromptSubmit({ prompt: 'Never delete anything in data/exports.', cwd: r7, session_id: 's-e' });
  const run = () => preToolUse({ tool_name: 'bash', tool_input: { command: 'rm -rf data/exports' }, cwd: r7, session_id: 's-e', tool_use_id: `e${Math.random()}` });
  // a question or a vague remark grants nothing
  await userPromptSubmit({ prompt: 'Could we delete data/exports this once?', cwd: r7, session_id: 's-e' });
  assert.ok(denied(await run()));
  const out = await userPromptSubmit({ prompt: 'Fine, go ahead and delete data/exports this once.', cwd: r7, session_id: 's-e' });
  assert.match(out.hookSpecificOutput.additionalContext, /allow one call/);
  assert.deepStrictEqual(await run(), {});
  assert.ok(denied(await run()), 'the rule applies again after one use');
});

test('questions, refusals and look-alike words never widen a rule (offline)', async () => {
  const r8 = path.join(tmp, 'widen');
  fs.mkdirSync(path.join(r8, '.git'), { recursive: true });
  fs.mkdirSync(path.join(r8, 'data'), { recursive: true });
  await userPromptSubmit({ prompt: 'Never delete anything in data/.', cwd: r8, session_id: 's-w' });
  const run = () => preToolUse({ tool_name: 'bash', tool_input: { command: 'rm -rf data/export.csv' }, cwd: r8, session_id: 's-w', tool_use_id: `w${Math.random()}` });
  assert.ok(denied(await run()));
  for (const p of ['Is it allowed to delete the data folder?', "I'm not sure, don't do it, it's risky.", 'Is that allowed? Why was it blocked?']) {
    const out = await userPromptSubmit({ prompt: p, cwd: r8, session_id: 's-w' });
    assert.ok(!out.hookSpecificOutput, p);
    assert.ok(denied(await run()), p);
  }
  // with no block to answer, a one-time yes must name the path as a word
  const fresh = () => preToolUse({ tool_name: 'bash', tool_input: { command: 'rm -rf data/export.csv' }, cwd: r8, session_id: 's-w2', tool_use_id: `w${Math.random()}` });
  const out = await userPromptSubmit({ prompt: 'Sure, this once, the metadata looks fine.', cwd: r8, session_id: 's-w2' });
  assert.ok(!out.hookSpecificOutput);
  assert.ok(denied(await fresh()));
});

test('undo never writes through a symlink or outside the workspace', async () => {
  const r9 = path.join(tmp, 'undo-safe');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(r9, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(r9, 'a.txt'), 'orig');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'CHANGED');
  snapshot.take(r9, { tool_use_id: 'u1', session_id: 's-u', tool: 'write_file', summary: 'a.txt', paths: [path.join(r9, 'a.txt'), path.join(outside, 'new.txt')] });
  fs.rmSync(path.join(r9, 'a.txt'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(r9, 'a.txt'));
  fs.writeFileSync(path.join(outside, 'new.txt'), 'keep me');
  const res = snapshot.undo(r9);
  assert.ok(res.ok);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'CHANGED');
  assert.ok(!fs.lstatSync(path.join(r9, 'a.txt')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(r9, 'a.txt'), 'utf8'), 'orig');
  assert.strictEqual(fs.readFileSync(path.join(outside, 'new.txt'), 'utf8'), 'keep me');
  assert.ok(!snapshot.undo(r9, 0).ok, 'step 0 is rejected');
});
