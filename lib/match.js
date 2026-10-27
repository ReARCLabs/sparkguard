'use strict';
// Turns a Muse Code tool call into "what it would touch" and checks that against rules.
// Everything here is local and synchronous: this is the fast path the hook runs on
// every tool call, so it must never wait on the network.
const path = require('path');

const READ_ONLY_TOOL = /^(read_|list_|search|grep|glob|find_|get_|view|submit_|web_|fetch|todo|plan|ask_|spawn|wait|task)/;
const MUTATING_TOOL = /(write|edit|delete|remove|move|rename|create|patch|replace|append|mkdir|copy)/;

const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'ag', 'wc', 'stat', 'file', 'du', 'df',
  'tree', 'pwd', 'which', 'whoami', 'echo', 'printf', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'jq',
  'node', 'python3', 'python', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'make', 'cargo', 'go', 'pytest',
  'true', 'false', 'test', '[', 'date', 'env', 'basename', 'dirname', 'realpath', 'sha256sum', 'shasum',
]);
const MUTATING_CMDS = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'truncate', 'shred', 'dd', 'chmod', 'chown', 'ln', 'touch',
  'mkdir', 'tee', 'install', 'rsync', 'trash',
]);
const GIT_MUTATING = new Set(['rm', 'mv', 'checkout', 'restore', 'reset', 'clean', 'commit', 'push', 'stash', 'rebase', 'merge', 'apply', 'am', 'revert', 'cherry-pick', 'switch']);

// Rough shell tokenizer: handles quotes, splits segments on ; && || | and newlines.
function segments(command) {
  const out = [];
  let cur = [];
  let tok = '';
  let q = null;
  let hasTok = false;
  const push = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false; } };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === q) q = null; else tok += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; hasTok = true; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      push();
      if (cur.length) out.push(cur);
      cur = [];
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      continue;
    }
    if (c === '>') {
      push();
      if (command[i + 1] === '>') i++;
      cur.push('>');
      continue;
    }
    tok += c;
    hasTok = true;
  }
  push();
  if (cur.length) out.push(cur);
  return out;
}

function isPathLike(t) {
  if (!t || t.startsWith('-')) return false;
  if (/^[a-z]+:\/\//i.test(t)) return false;
  return t.includes('/') || t.includes('.') || t === '*' || /^[\w@~-]+$/.test(t);
}

// Analyse a whole command line, following `cd` between segments
// ("cd data && rm -rf exports" deletes data/exports).
function analyzeCommand(command, base) {
  let b = base;
  const out = [];
  for (const seg of segments(command)) {
    if (seg[0] === 'cd') {
      const to = seg[1] && !seg[1].startsWith('-') ? seg[1].replace(/^~(?=\/|$)/, process.env.HOME || '~') : process.env.HOME || b;
      b = path.resolve(b, to);
      continue;
    }
    out.push(analyzeSegment(seg, b));
  }
  // `... | xargs rm` with no explicit target deletes whatever the pipeline listed.
  const listed = out.flatMap((s) => s.mentionedArgs || []);
  for (const s of out) if (s.pipedDelete && !s.deletes.length) { s.deletes = listed; s.paths = listed; }
  return out;
}

const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a']);

// Returns { mutating, paths: [abs], deletes: [abs], text } for one segment.
// `deletes` are paths the segment removes; deleting a parent removes what a rule protects.
function analyzeSegment(seg, base) {
  let i = 0;
  while (i < seg.length && /^\w+=/.test(seg[i])) i++; // env assignments
  let cmd = seg[i];
  if (cmd === 'sudo' || cmd === 'command' || cmd === 'exec') cmd = seg[++i];
  const args = seg.slice(i + 1);
  const name = cmd ? path.basename(cmd) : '';
  let mutating = false;
  const targets = [];

  // Nested shell: analyse the inner command like any other.
  if (/^(bash|sh|zsh|dash|fish)$/.test(name)) {
    const ci = args.indexOf('-c');
    if (ci !== -1 && args[ci + 1]) {
      const inner = analyzeCommand(args[ci + 1], base);
      return {
        name,
        mutating: inner.some((s) => s.mutating),
        opaque: inner.some((s) => s.opaque),
        destructiveCode: inner.some((s) => s.destructiveCode),
        paths: inner.flatMap((s) => s.paths),
        deletes: inner.flatMap((s) => s.deletes || []),
        text: seg.join(' '),
      };
    }
  }
  // xargs runs its command on piped input: analyse that command.
  if (name === 'xargs') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += XARGS_VALUE_FLAGS.has(args[k]) ? 2 : 1;
    if (args[k]) {
      const inner = analyzeSegment(args.slice(k), base);
      if (DELETE_CMDS.has(inner.name)) inner.pipedDelete = true;
      return inner;
    }
  }
  // Inline code (python -c, node -e, ruby -e, perl -e, deno eval): we cannot parse
  // it reliably, so any protected path it names goes to the referee, not an exact deny.
  const INLINE = { python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p'], bun: ['-e', '--eval'], deno: ['eval'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'] };
  if (INLINE[name]) {
    const fi = args.findIndex((a) => INLINE[name].includes(a));
    if (fi !== -1 && args[fi + 1]) {
      const code = args[fi + 1];
      const quoted = [...code.matchAll(/["'`]([^"'`]{1,300})["'`]/g)].map((m) => m[1]).filter((q) => /[\w.-]\/|^\.?[\w-]+\.[\w]+$|^[\w.-]+$/.test(q) && !/\s/.test(q));
      const destructive = /\b(rmtree|rmSync|rmdirSync|unlink(Sync)?|remove|rmdir|rm_rf|truncate|writeFile(Sync)?|write_text|write_bytes|rename(Sync)?|move|copyfile|replace|delete|drop|os\.system|subprocess|execSync|spawnSync|child_process)\b|open\([^)]*['"][wa]\+?['"]/.test(code);
      return { name, mutating: destructive, opaque: true, destructiveCode: destructive, paths: quoted.map((q) => path.resolve(base, q)), deletes: [], text: seg.join(' ') };
    }
  }

  const redirect = args.indexOf('>');
  if (redirect !== -1 && args[redirect + 1]) {
    mutating = true;
    targets.push(args[redirect + 1]);
  }
  const plain = args.filter((a, k) => a !== '>' && args[k - 1] !== '>');

  const deletes = [];
  if (name === 'cp' || name === 'install') {
    // Only the destination is written; sources are read.
    mutating = true;
    const pa = plain.filter(isPathLike);
    if (pa.length) targets.push(pa[pa.length - 1]);
  } else if (MUTATING_CMDS.has(name)) {
    mutating = true;
    const pa = plain.filter(isPathLike);
    targets.push(...pa);
    if (DELETE_CMDS.has(name)) deletes.push(...pa);
    else if (name === 'mv') deletes.push(...pa.slice(0, -1));
    else if (name === 'rsync' && plain.some((a) => a.startsWith('--delete')) && pa.length) deletes.push(pa[pa.length - 1]);
  } else if (name === 'git' && GIT_MUTATING.has(plain[0])) {
    mutating = true;
    const pa = plain.slice(1).filter((a) => isPathLike(a) && a !== '--');
    targets.push(...pa);
    if (plain[0] === 'rm') deletes.push(...pa);
    // git clean removes untracked (and with -x, ignored) files under its paths or the cwd.
    if (plain[0] === 'clean' && plain.some((a) => /^-\w*f/.test(a) || a === '--force')) deletes.push(...(pa.length ? pa : ['.']));
  } else if (name === 'tar' && plain.includes('--remove-files')) {
    mutating = true;
    const pa = plain.filter((a) => isPathLike(a) && !/\.(t?gz|tar|tgz|bz2|xz|zst|zip)$/.test(a));
    targets.push(...pa);
    deletes.push(...pa);
  } else if ((name === 'sed' || name === 'perl') && plain.some((a) => /^-i/.test(a) || a === '-pi')) {
    mutating = true;
    targets.push(...plain.filter((a) => isPathLike(a) && !a.includes(' ') && (a.includes('/') || /\.\w+$/.test(a))));
  } else if (name === 'find' && plain.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    mutating = true;
    const root0 = plain.filter((a) => isPathLike(a) && !a.startsWith('-')).slice(0, 1);
    targets.push(...root0);
    deletes.push(...root0);
  } else if (!READ_ONLY_CMDS.has(name) && name) {
    // Unknown program: not treated as a file mutation, but its paths are still
    // reported so keyword rules can see them.
    targets.push(...plain.filter((a) => a.includes('/')));
  }
  const abs = (t) => path.resolve(base, t.replace(/^~(?=\/|$)/, process.env.HOME || '~').replace(/^\$(PWD|\{PWD\})(?=\/|$)/, base));
  return {
    name,
    mutating,
    paths: targets.map(abs),
    deletes: deletes.map(abs),
    mentionedArgs: plain.filter((a) => a.includes('/') && !a.startsWith('-')).map(abs),
    text: seg.join(' '),
  };
}

// Normalise a PreToolUse payload. Returns null for calls Sparkguard ignores.
function normalize(payload) {
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  if (!tool) return null;

  if (tool === 'bash' || tool === 'shell' || tool === 'shell_execute' || tool === 'run_command') {
    const command = String(input.command || input.cmd || '');
    const base = input.workdir ? path.resolve(cwd, input.workdir) : cwd;
    const segs = analyzeCommand(command, base);
    const mutating = segs.some((s) => s.mutating);
    return {
      tool,
      kind: 'shell',
      mutating,
      opaque: segs.some((s) => s.opaque && s.mutating),
      destructiveCode: segs.some((s) => s.destructiveCode),
      paths: segs.filter((s) => s.mutating).flatMap((s) => s.paths),
      deletes: segs.flatMap((s) => s.deletes || []),
      mentioned: segs.flatMap((s) => s.paths),
      command,
      summary: command.slice(0, 300),
    };
  }

  if (tool.startsWith('mcp__')) {
    const op = tool.split('__').pop() || '';
    const readLike = /^(read|get|list|search|find|view|stat|describe|query|fetch|show|count|exists|head|tail)/i.test(op) && !MUTATING_TOOL.test(op);
    const found = [];
    const walkArgs = (v, key) => {
      if (typeof v === 'string') {
        if ((/path|file|dir|target|dest|source|src|from|to/i.test(key || '') || v.includes('/')) && !/^[a-z]+:\/\//i.test(v) && v.length < 400 && !/\s/.test(v)) found.push(v);
      } else if (Array.isArray(v)) v.forEach((x) => walkArgs(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkArgs(x, k);
    };
    walkArgs(input, '');
    const paths = found.map((p) => path.resolve(cwd, p));
    return { tool, kind: 'mcp', mutating: !readLike, paths: readLike ? [] : paths, mentioned: paths, command: '', summary: `${tool} ${JSON.stringify(input).slice(0, 300)}` };
  }

  if (READ_ONLY_TOOL.test(tool) && !MUTATING_TOOL.test(tool)) return null;
  if (!MUTATING_TOOL.test(tool)) return null;

  const fields = ['path', 'file_path', 'target', 'destination', 'dest', 'source', 'from', 'to', 'new_path', 'old_path'];
  const raw = fields.map((f) => input[f]).filter((v) => typeof v === 'string' && v);
  if (Array.isArray(input.paths)) raw.push(...input.paths.filter((v) => typeof v === 'string'));
  const paths = raw.map((p) => path.resolve(cwd, p));
  return { tool, kind: 'file', mutating: true, paths, mentioned: paths, command: '', summary: `${tool} ${raw.join(' ')}` };
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Does an absolute path fall under a rule path (relative to the project root)?
function pathMatches(absPath, rulePath, root) {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  if (rel.startsWith('..')) return false;
  const rp = rulePath.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rp) return false;
  if (/[*?]/.test(rp)) {
    const re = globToRegex(rp);
    if (re.test(rel)) return true;
    // a glob naming a directory protects everything under it
    const parts = rel.split('/');
    for (let k = 1; k <= parts.length; k++) if (re.test(parts.slice(0, k).join('/'))) return true;
    return false;
  }
  if (rel === rp || rel.startsWith(`${rp}/`)) return true;
  // a bare name ("migrations", ".env") matches that path segment anywhere
  if (!rp.includes('/')) return rel.split('/').includes(rp);
  return false;
}

// Does deleting absPath remove what rulePath protects? True when the rule path
// is absPath itself or lies under it ("rm -rf data" removes data/exports), or when
// absPath is a glob that covers the rule path or one of its parents ("data/ex*").
function deletionCovers(absPath, rulePath, root) {
  const staticPart = rulePath.replace(/^\.\//, '').split(/[*?]/)[0].replace(/\/+$/, '');
  if (!staticPart) return false;
  const ruleAbs = path.resolve(root, staticPart);
  if (/[*?]/.test(absPath)) {
    const re = globToRegex(absPath);
    const parts = ruleAbs.split('/');
    for (let k = 2; k <= parts.length; k++) if (re.test(parts.slice(0, k).join('/'))) return true;
    return false;
  }
  const rel = path.relative(absPath, ruleAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A rule command matches when its words appear in order inside one shell
// segment, ignoring flags: "git push origin main" matches "git push -f origin main".
function commandMatches(command, ruleCmd) {
  if (!ruleCmd) return false;
  const words = (s) => s.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith('-'));
  const want = words(ruleCmd);
  if (!want.length) return false;
  return segments(command).some((seg) => {
    // text that only mentions the command (echo, grep, man ...) does not run it
    if (/^(echo|printf|grep|rg|ag|cat|man|which|type|help|#)$/.test(path.basename(seg[0] || ''))) return false;
    const have = words(seg.join(' '));
    let i = 0;
    for (const w of have) if (w === want[i] && ++i === want.length) return true;
    return false;
  });
}

const GENERIC = new Set(['service', 'services', 'file', 'files', 'code', 'repo', 'folder', 'directory', 'project', 'thing', 'stuff', 'data', 'table', 'config', 'module']);
// Distinctive words of a keyword rule ("billing service" -> ["billing"]).
function keywordWords(k) {
  return k.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length >= 4 && !GENERIC.has(w));
}

// Deterministic check. Returns { hits: [{rule, why}], candidates: [rule] }.
// hits = exact path/command matches (deny without a model call).
// candidates = rules that might apply (send to the judge).
function check(call, rules, root) {
  const hits = [];
  const candidates = [];
  for (const rule of rules) {
    let hit = null;
    let opaqueHit = false;
    for (const p of call.deletes || []) {
      const rp = (rule.paths || []).find((g) => deletionCovers(p, g, root));
      if (rp) { hit = `deletes ${path.relative(root, p) || '.'}, which contains ${rp} (protected)`; break; }
    }
    if (!hit && call.mutating) {
      for (const p of call.paths) {
        const rp = (rule.paths || []).find((g) => pathMatches(p, g, root));
        // Inline code that names the protected path AND calls a destructive API
        // (rmtree, rmSync, unlink, ...) is unambiguous: deny without a model.
        if (rp && call.opaque && call.destructiveCode) { hit = `runs code that deletes or overwrites ${path.relative(root, p) || p} (protected: ${rp})`; break; }
        if (rp && call.opaque) { opaqueHit = true; break; }
        if (rp) { hit = `touches ${path.relative(root, p) || p} (protected: ${rp})`; break; }
      }
    }
    if (!hit && call.kind === 'shell' && call.mutating === false) {
      // read-only shell never hits a path rule
    }
    let loose = false;
    if (!hit && call.command) {
      // Multi-word prefixes ("git push origin main") match exactly; a single word
      // ("push") is too broad to deny on its own, so it goes to the referee.
      const rc = (rule.commands || []).find((c) => commandMatches(call.command, c));
      if (rc && rc.trim().split(/\s+/).length >= 2) hit = `runs "${rc}"`;
      else if (rc) loose = true;
    }
    if (hit) { hits.push({ rule, why: hit }); continue; }
    const hay = `${call.summary} ${call.mentioned.join(' ')}`.toLowerCase();
    const kw = (rule.keywords || []).some((k) => k && (hay.includes(k.toLowerCase()) || keywordWords(k).some((w) => hay.includes(w))));
    const nearPath = call.mutating && (rule.paths || []).some((g) => hay.includes(g.replace(/\*+/g, '').replace(/\/+$/, '').toLowerCase()) && g.replace(/\*+/g, '').length > 2);
    if (opaqueHit || loose || (call.mutating && (kw || nearPath || (call.kind === 'mcp' && (rule.keywords || []).length)))) candidates.push(rule);
  }
  return { hits, candidates };
}

module.exports = { segments, analyzeSegment, analyzeCommand, normalize, pathMatches, deletionCovers, commandMatches, globToRegex, check };
