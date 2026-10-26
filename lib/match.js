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

// Returns { mutating, paths: [abs], text } for one segment.
function analyzeSegment(seg, base) {
  let i = 0;
  while (i < seg.length && /^\w+=/.test(seg[i])) i++; // env assignments
  let cmd = seg[i];
  if (cmd === 'sudo' || cmd === 'command' || cmd === 'exec') cmd = seg[++i];
  const args = seg.slice(i + 1);
  const name = cmd ? path.basename(cmd) : '';
  let mutating = false;
  const targets = [];

  const redirect = args.indexOf('>');
  if (redirect !== -1 && args[redirect + 1]) {
    mutating = true;
    targets.push(args[redirect + 1]);
  }
  const plain = args.filter((a, k) => a !== '>' && args[k - 1] !== '>');

  if (MUTATING_CMDS.has(name)) {
    mutating = true;
    targets.push(...plain.filter(isPathLike));
  } else if (name === 'git' && GIT_MUTATING.has(plain[0])) {
    mutating = true;
    targets.push(...plain.slice(1).filter((a) => isPathLike(a) && a !== '--'));
  } else if ((name === 'sed' || name === 'perl') && plain.some((a) => /^-i/.test(a) || a === '-pi')) {
    mutating = true;
    targets.push(...plain.filter((a) => isPathLike(a) && !a.includes(' ') && (a.includes('/') || /\.\w+$/.test(a))));
  } else if (name === 'find' && plain.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    mutating = true;
    targets.push(...plain.filter((a) => isPathLike(a) && !a.startsWith('-')).slice(0, 1));
  } else if (!READ_ONLY_CMDS.has(name) && name) {
    // Unknown program: not treated as a file mutation, but its paths are still
    // reported so keyword rules can see them.
    targets.push(...plain.filter((a) => a.includes('/')));
  }
  return {
    name,
    mutating,
    paths: targets.map((t) => path.resolve(base, t.replace(/^~(?=\/|$)/, process.env.HOME || '~'))),
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
    const segs = segments(command).map((s) => analyzeSegment(s, base));
    const mutating = segs.some((s) => s.mutating);
    return {
      tool,
      kind: 'shell',
      mutating,
      paths: segs.filter((s) => s.mutating).flatMap((s) => s.paths),
      mentioned: segs.flatMap((s) => s.paths),
      command,
      summary: command.slice(0, 300),
    };
  }

  if (tool.startsWith('mcp__')) {
    return { tool, kind: 'mcp', mutating: true, paths: [], mentioned: [], command: '', summary: JSON.stringify(input).slice(0, 400) };
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
    if (call.mutating) {
      for (const p of call.paths) {
        const rp = (rule.paths || []).find((g) => pathMatches(p, g, root));
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
    if (loose || (call.mutating && (kw || nearPath || (call.kind === 'mcp' && (rule.keywords || []).length)))) candidates.push(rule);
  }
  return { hits, candidates };
}

module.exports = { segments, analyzeSegment, normalize, pathMatches, commandMatches, globToRegex, check };
