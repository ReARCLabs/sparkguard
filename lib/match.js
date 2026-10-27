'use strict';
// Turns a Muse Code tool call into "what it would touch" and checks that against rules.
// Everything here is local and synchronous: this is the fast path the hook runs on
// every tool call, so it must never wait on the network.
const fs = require('fs');
const path = require('path');

const READ_ONLY_TOOL = /^(read_|list_|search|grep|glob|find_|get_|view|submit_|web_|fetch|todo|plan|ask_|spawn|wait|task)/;
const MUTATING_TOOL = /(write|edit|delete|remove|move|rename|create|patch|replace|append|mkdir|copy)/;

const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'ag', 'wc', 'stat', 'file', 'du', 'df',
  'tree', 'pwd', 'which', 'whoami', 'echo', 'printf', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'jq',
  'node', 'python3', 'python', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'make', 'cargo', 'go', 'pytest',
  'true', 'false', 'test', '[', 'date', 'env', 'basename', 'dirname', 'realpath', 'sha256sum', 'shasum',
  'mkdir', 'touch',
]);
const MUTATING_CMDS = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'truncate', 'shred', 'dd', 'chmod', 'chown', 'ln',
  'tee', 'install', 'rsync', 'trash',
]);
// Subcommands that change files in the working tree (commit and push do not).
const GIT_WORKTREE = new Set(['read-tree', 'worktree', 'rm', 'mv', 'checkout', 'restore', 'reset', 'clean', 'stash', 'rebase', 'merge', 'apply', 'am', 'revert', 'cherry-pick', 'switch', 'pull']);
const GIT_MUTATING = new Set([...GIT_WORKTREE, 'commit', 'push']);
const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put', 'srm', 'rimraf', 'del', 'del-cli']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a']);
// Words that start a shell construct or wrap another command; the real command follows.
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', '(', ')', 'time', 'done', 'fi']);
const WRAPPERS = { npx: ['-p', '--package'], bunx: [], pnpx: [], sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t'], doas: ['-u', '-C'], nohup: [], nice: ['-n'], ionice: ['-c', '-n'], timeout: ['-s', '-k', '--signal', '--kill-after'], stdbuf: [], unbuffer: [], command: [], exec: [], builtin: [], env: ['-u', '-C', '-S'], caffeinate: [] };
const INLINE = { python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p'], bun: ['-e', '--eval'], deno: ['eval'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'] };
const SHELLS = /^(bash|sh|zsh|dash|fish|ksh)$/;
// Library calls that delete or overwrite files, in the languages agents use for one-liners.
const DESTRUCTIVE_CODE = /\b(unlink|rmtree|remove_tree|rm_rf|rmdir)\b(?!\s*[=:])|\b(rmtree|rmSync|rmdirSync|rm|rmdir|removedirs|removeSync|unlink(Sync)?|remove|rm_rf|rm_r|truncate|writeFile(Sync)?|writeTextFile(Sync)?|appendFile(Sync)?|write_text|write_bytes|rename(Sync)?|move|send2trash|os\.system|subprocess|execSync|spawnSync|child_process|system|exec)\s*\(|open\([^)]*['"][wax]\+?b?['"]|\.write\(|File\.(delete|write)|FileUtils\./;
// Copies write only their destination, which a regex cannot tell apart from the source:
// code that copies and names a protected path goes to the referee instead of a deny.
const COPY_CODE = /\b(copy|copy2|copyfile|copytree|copyFile(Sync)?|cpSync|copy_file)\s*\(/;

// Shell tokenizer: quotes, backslash escapes, heredocs, redirections, and segments split on
// ; && || | & ( ) and newlines. A heredoc body is attached to its segment as `heredoc`.
function segments(command) {
  const out = [];
  let cur = [];
  let tok = '';
  let q = null;
  let hasTok = false;
  const pending = []; // heredoc delimiters waiting for the next newline
  const push = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false; } };
  const end = () => { push(); if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < command.length) tok += command[++i];
      else tok += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') { tok += command[i + 1]; hasTok = true; }
      i++;
      continue;
    }
    if (c === '"' || c === "'") { q = c; hasTok = true; continue; }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      push();
      i += 2;
      if (command[i] === '-') i++;
      while (command[i] === ' ') i++;
      let d = '';
      while (i < command.length && !/[\s;&|]/.test(command[i])) d += command[i++];
      i--;
      d = d.replace(/^['"]|['"]$/g, '');
      if (d) pending.push({ seg: cur, delim: d });
      continue;
    }
    if (c === '\n' && pending.length) {
      // Read heredoc bodies; they are data (or code for an interpreter), never commands.
      let j = i + 1;
      for (const h of pending) {
        const body = [];
        while (j < command.length) {
          const nl = command.indexOf('\n', j);
          const line = command.slice(j, nl === -1 ? command.length : nl);
          j = nl === -1 ? command.length : nl + 1;
          if (line.trim() === h.delim) break;
          body.push(line);
        }
        h.seg.heredoc = (h.seg.heredoc ? `${h.seg.heredoc}\n` : '') + body.join('\n');
      }
      pending.length = 0;
      end();
      i = j - 1;
      continue;
    }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      // >, >>, >|, &>, &>>, >& are all writes to the next word
      push();
      if (c === '&') i++;
      if (command[i + 1] === '>') i++;
      if (command[i + 1] === '|' || command[i + 1] === '&') i++;
      cur.push('>');
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') {
      if (c === '(' && tok === '$') { tok += c; continue; }
      end();
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      continue;
    }
    tok += c;
    hasTok = true;
  }
  end();
  return out;
}

function isPathLike(t) {
  if (!t || t.startsWith('-')) return false;
  if (/^[a-z]+:\/\//i.test(t)) return false;
  return t.includes('/') || t.includes('.') || t === '*' || /^[\w@~-]+$/.test(t);
}

// One level of brace expansion: data/{exports,tmp} -> data/exports, data/tmp.
function expandBraces(t) {
  const m = t.match(/^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/);
  return m ? m[2].split(',').map((x) => `${m[1]}${x}${m[3]}`) : [t];
}

// Analyse a whole command line, following `cd`/`pushd` between segments
// ("cd data && rm -rf exports" deletes data/exports).
function analyzeCommand(command, base) {
  let b = base;
  const out = [];
  for (const seg of segments(command)) {
    const words = seg.filter((w) => !KEYWORDS.has(w));
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const dest = words.slice(1).find((w) => !w.startsWith('-'));
      b = path.resolve(b, dest ? dest.replace(/^~(?=\/|$)/, process.env.HOME || '~') : process.env.HOME || b);
      continue;
    }
    out.push(analyzeSegment(seg, b));
  }
  // `... | xargs rm` with no explicit target deletes whatever the pipeline listed.
  const listed = out.flatMap((s) => s.mentionedArgs || []);
  for (const s of out) if (s.pipedDelete && !s.deletes.length) { s.deletes = listed; s.paths = listed; }
  return out;
}

function merge(name, inner, text) {
  return {
    name,
    mutating: inner.some((s) => s.mutating),
    opaque: inner.some((s) => s.opaque),
    destructiveCode: inner.some((s) => s.destructiveCode),
    paths: inner.flatMap((s) => s.paths),
    deletes: inner.flatMap((s) => s.deletes || []),
    maybeDeletes: inner.flatMap((s) => s.maybeDeletes || []),
    soft: inner.flatMap((s) => s.soft || []),
    mentionedArgs: inner.flatMap((s) => s.mentionedArgs || []),
    text,
  };
}

// Strip constructs and wrappers in front of the real command:
// `if`, `do`, `{`, `sudo -u x`, `timeout 60`, `nice -n 5`, `env A=1`, assignments.
function commandStart(seg) {
  let i = 0;
  for (;;) {
    while (i < seg.length && (KEYWORDS.has(seg[i]) || /^\w+=/.test(seg[i]))) i++;
    const w = seg[i] ? path.basename(seg[i]) : '';
    if (!WRAPPERS[w]) break;
    i++;
    while (i < seg.length && seg[i].startsWith('-')) i += WRAPPERS[w].includes(seg[i]) ? 2 : 1;
    if (w === 'timeout' && /^\d/.test(seg[i] || '')) i++;
    if ((w === 'nice' || w === 'ionice') && /^-?\d+$/.test(seg[i] || '')) i++;
  }
  return i;
}

// Returns { mutating, paths: [abs], deletes: [abs], text } for one segment.
// `deletes` are paths the segment removes; deleting a parent removes what a rule protects.
// `maybeDeletes` are roots of a filtered delete (find -name ...): the referee decides.
function analyzeSegment(seg, base) {
  const text = seg.join(' ');
  const abs = (t) => path.resolve(base, t.replace(/^~(?=\/|$)/, process.env.HOME || '~').replace(/^\$(PWD|\{PWD\})(?=\/|$)/, base));
  // Redirections anywhere in the segment write to their target (2>&1, >&2 do not).
  const redirects = [];
  const words = [];
  for (let k = 0; k < seg.length; k++) {
    if (seg[k] === '>') { const t = seg[k + 1]; if (t && !/^(\d+|-)$/.test(t)) redirects.push(t); k++; } else words.push(seg[k]);
  }
  const start = commandStart(words);
  const cmd = words[start];
  const args = words.slice(start + 1);
  const name = cmd ? path.basename(cmd) : '';
  let mutating = redirects.length > 0;
  const targets = [...redirects];
  const deletes = [];
  const maybeDeletes = [];
  const soft = [];

  // eval and nested shells: analyse the inner command like any other.
  if (name === 'eval') return merge(name, analyzeCommand(args.join(' '), base), text);
  if (SHELLS.test(name)) {
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    if (ci !== -1 && args[ci + 1]) return merge(name, analyzeCommand(args[ci + 1], base), text);
    if (seg.heredoc) return merge(name, analyzeCommand(seg.heredoc, base), text);
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
  // Inline or stdin code (python -c, node -e, python3 <<EOF): we cannot parse it, so it is
  // opaque. If it calls a destructive API and names a protected path, that is a deny;
  // otherwise any protected path it names goes to the referee.
  if (INLINE[name]) {
    const fi = args.findIndex((a) => INLINE[name].includes(a) || (name === 'perl' && /^-\w*e$/.test(a)));
    const firstPos = args.find((a) => a === '-' || !a.startsWith('-'));
    const code = fi !== -1 ? args[fi + 1] : (seg.heredoc && (firstPos === undefined || firstPos === '-') ? seg.heredoc : null);
    // arguments after `-` reach the code as sys.argv / process.argv
    const argvPaths = fi === -1 && firstPos === '-' ? args.slice(args.indexOf('-') + 1).filter(isPathLike) : [];
    if (code) {
      const quoted = [...code.matchAll(/["'`]([^"'`]{1,300})["'`]/g)].map((m) => m[1]).filter((q) => /[\w.-]\/|^\.?[\w-]+\.[\w]+$|^[\w.-]+$/.test(q) && !/\s/.test(q));
      let destructive = DESTRUCTIVE_CODE.test(code);
      const copies = !destructive && COPY_CODE.test(code);
      const files = [...argvPaths];
      // perl -pi -e '...' file: in-place edit of the files after the code
      if (name === 'perl' && args.some((a) => /^-\w*i/.test(a))) { destructive = true; files.push(...args.slice(fi + 2).filter(isPathLike)); }
      const paths = [...quoted, ...files].flatMap(expandBraces).map(abs);
      return { name, mutating: destructive || copies || files.length > 0, opaque: true, destructiveCode: destructive, paths, deletes: [], mentionedArgs: paths, text };
    }
  }

  const plain = args;
  const pathArgs = () => plain.filter(isPathLike).flatMap(expandBraces);
  if (name === 'cp' || name === 'install') {
    // Only the destination is written; sources are read.
    mutating = true;
    const ti = plain.findIndex((a) => a === '-t' || a === '--target-directory');
    const pa = pathArgs();
    if (ti !== -1 && plain[ti + 1]) targets.push(plain[ti + 1]);
    else if (pa.length) targets.push(pa[pa.length - 1]);
  } else if (name === 'dd') {
    const of = plain.find((a) => a.startsWith('of='));
    if (of) { mutating = true; targets.push(of.slice(3)); }
  } else if (name === 'rsync' || name === 'ln' || name === 'sponge') {
    // Only the destination is written (sponge takes it as its only argument).
    mutating = true;
    const pa = pathArgs();
    const dest = name === 'sponge' ? pa[0] : pa[pa.length - 1];
    if (dest) targets.push(dest);
    if (name === 'rsync' && dest && plain.some((a) => a.startsWith('--delete'))) deletes.push(dest);
  } else if (name === 'rclone') {
    const sub = plain.find((a) => !a.startsWith('-'));
    const pa = plain.filter((a) => !a.startsWith('-') && a !== sub && isPathLike(a));
    if (/^(delete|deletefile|purge|rmdir|rmdirs|cleanup)$/.test(sub || '')) { mutating = true; targets.push(...pa); deletes.push(...pa); }
    else if (/^(sync|move|moveto|copy|copyto|bisync)$/.test(sub || '') && pa.length) {
      mutating = true;
      targets.push(pa[pa.length - 1]);
      if (/^(sync|bisync)$/.test(sub)) deletes.push(pa[pa.length - 1]);
      if (/^move/.test(sub)) deletes.push(...pa.slice(0, -1));
    }
  } else if (name === 'zip' && plain.some((a) => /^-\w*m/.test(a) || a === '--move')) {
    // zip -m moves the inputs into the archive: they are deleted
    mutating = true;
    const pa = pathArgs();
    targets.push(...pa.slice(1));
    deletes.push(...pa.slice(1));
  } else if (MUTATING_CMDS.has(name) || DELETE_CMDS.has(name)) {
    mutating = true;
    const pa = pathArgs();
    targets.push(...pa);
    if (DELETE_CMDS.has(name)) deletes.push(...pa);
    else if (name === 'mv') deletes.push(...pa.slice(0, -1));
  } else if (name === 'git') {
    // global options before the subcommand: -C <dir> changes where it runs
    let k = 0;
    let gbase = base;
    while (k < plain.length && plain[k].startsWith('-')) {
      if (plain[k] === '-C' && plain[k + 1]) { gbase = path.resolve(base, plain[k + 1]); k += 2; } else if (plain[k] === '-c') k += 2; else k++;
    }
    const sub = plain[k];
    const rest = plain.slice(k + 1);
    if (GIT_MUTATING.has(sub)) {
      mutating = true;
      if (GIT_WORKTREE.has(sub)) {
        const dd = rest.indexOf('--');
        const pa = (dd !== -1 ? rest.slice(dd + 1) : rest).filter((a) => isPathLike(a) && a !== '--').flatMap(expandBraces);
        const gabs = (t) => path.resolve(gbase, t);
        targets.push(...pa.map(gabs));
        const cachedOnly = sub === 'rm' && rest.includes('--cached');
        if (cachedOnly) targets.length = 0; // --cached leaves the working tree alone
        if (sub === 'rm' && !cachedOnly) deletes.push(...pa.map(gabs));
        // git clean removes untracked (and with -x, ignored) files under its paths or the cwd.
        if (sub === 'clean' && rest.some((a) => /^-\w*f/.test(a) || a === '--force') && !rest.some((a) => /^-\w*n/.test(a) || a === '--dry-run')) deletes.push(...(pa.length ? pa : ['.']).map(gabs));
        // Discarding changes: reset --hard, checkout -- ., restore . (not --staged alone).
        if (sub === 'reset' && rest.includes('--hard')) deletes.push(gbase);
        if ((sub === 'checkout' || sub === 'switch') && rest.some((a) => a === '-f' || a === '--force' || a === '--discard-changes')) deletes.push(gbase);
        if ((sub === 'checkout' && dd !== -1) || (sub === 'restore' && !(rest.includes('--staged') && !rest.includes('--worktree')))) deletes.push(...pa.map(gabs));
        if (sub === 'checkout' && dd === -1 && rest.includes('.')) deletes.push(gbase);
        if (sub === 'read-tree' && rest.includes('-u') && rest.includes('--reset')) deletes.push(gbase);
        if (sub === 'worktree' && rest[0] === 'remove') deletes.push(...rest.slice(1).filter((a) => !a.startsWith('-')).map(gabs));
        if (sub === 'stash' && !['list', 'show'].includes(rest[0])) deletes.push(...(pa.length ? pa.map(gabs) : [gbase]));
      }
    }
  } else if (name === 'tar') {
    const flags = plain.filter((a) => a.startsWith('-') || /^[cxtruAz]+v?f?$/.test(a));
    const fl = flags.join('');
    const fi = plain.findIndex((a) => /^-?[a-zA-Z]*f[a-zA-Z]*$/.test(a) && !a.startsWith('--'));
    const archive = fi !== -1 ? plain[fi + 1] : null;
    const ci = plain.findIndex((a) => a === '-C' || a === '--directory');
    if (/x/.test(fl) && ci !== -1 && plain[ci + 1]) { mutating = true; targets.push(plain[ci + 1]); }
    if (/x/.test(fl)) {
      // named members are written out (restoring an old copy over a protected file)
      const members = plain.filter((a, k) => !a.startsWith('-') && a !== archive && k !== fi && plain[k - 1] !== '-C' && plain[k - 1] !== '--directory' && !/^[cxtruAzjJvf]+$/.test(a) && isPathLike(a));
      if (members.length) { mutating = true; const into = ci !== -1 ? plain[ci + 1] : '.'; targets.push(...members.map((m) => path.join(into, m))); }
    }
    if (/c/.test(fl) && archive) { mutating = true; targets.push(archive); }
    if (plain.includes('--remove-files')) {
      mutating = true;
      const pa = pathArgs().filter((a) => a !== archive && !/\.(t?gz|tar|tgz|bz2|xz|zst|zip)$/.test(a));
      targets.push(...pa);
      deletes.push(...pa);
    }
  } else if (/^(gzip|bzip2|xz|zstd|lz4)$/.test(name) && !plain.some((a) => /^-\w*[kcdt]/.test(a) || a === '--keep' || a === '--stdout')) {
    // compressing replaces the original file
    mutating = true;
    const pa = pathArgs();
    targets.push(...pa);
    deletes.push(...pa);
  } else if (name === 'unzip') {
    const di = plain.indexOf('-d');
    if (di !== -1 && plain[di + 1]) { mutating = true; targets.push(plain[di + 1]); }
  } else if (name === 'curl' || name === 'wget') {
    const oi = plain.findIndex((a) => a === '-o' || a === '--output' || a === '-O' || a === '--output-document');
    if (oi !== -1 && plain[oi + 1] && !/^https?:/.test(plain[oi + 1])) { mutating = true; targets.push(plain[oi + 1]); }
  } else if ((name === 'sed' || name === 'perl') && plain.some((a) => /^-\w*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))) {
    mutating = true;
    targets.push(...plain.filter((a) => isPathLike(a) && !a.includes(' ') && (a.includes('/') || /\.\w+$/.test(a))));
  } else if (name === 'find' && plain.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    mutating = true;
    const root0 = plain.filter((a) => isPathLike(a) && !a.startsWith('-')).slice(0, 1);
    targets.push(...root0);
    // A filter narrows what is deleted. Name filters are checked against the protected
    // files on disk; other filters (-path, -mtime, ...) go to the referee.
    const names = [];
    let other = false;
    for (let k = 0; k < plain.length; k++) {
      if (plain[k] === '-name' || plain[k] === '-iname') names.push({ glob: plain[k + 1] || '*', ci: plain[k] === '-iname' });
      else if (/^-(i?path|i?regex|newer|mtime|mmin|size|wholename|links|user|perm)$/.test(plain[k])) other = true;
    }
    if (names.length || other) maybeDeletes.push(...root0.map((r) => ({ root: r, names, other })));
    else deletes.push(...root0);
  } else if (!READ_ONLY_CMDS.has(name) && name) {
    // Unknown program (sqlite3, awk, a CLI we don't model): we can't tell whether it
    // writes, so a protected path among its arguments goes to the referee.
    soft.push(...plain.filter((a) => a.includes('/') && !/^[a-z]+:\/\//i.test(a)));
  }
  return {
    name,
    mutating,
    paths: targets.flatMap(expandBraces).map(abs),
    deletes: deletes.flatMap(expandBraces).map(abs),
    maybeDeletes: maybeDeletes.map((m) => ({ ...m, root: abs(m.root) })),
    soft: soft.map(abs),
    mentionedArgs: plain.filter((a) => a.includes('/') && !a.startsWith('-')).map(abs),
    text,
  };
}

// Normalise a PreToolUse payload. Returns null for calls Sparkguard ignores.
function normalize(payload) {
  // Hosts differ in casing ("Bash", "Write"); match on the lower-case name.
  const tool = String(payload.tool_name || '').toLowerCase();
  const input = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  if (!tool) return null;

  if (tool === 'bash' || tool === 'shell' || tool === 'shell_execute' || tool === 'run_command') {
    const command = String(input.command || input.cmd || '');
    const base = input.workdir ? path.resolve(cwd, input.workdir) : cwd;
    const segs = analyzeCommand(command, base);
    const soft = segs.flatMap((s) => s.soft || []);
    const mutating = segs.some((s) => s.mutating) || soft.length > 0;
    return {
      tool,
      kind: 'shell',
      mutating,
      opaque: segs.some((s) => s.opaque && s.mutating),
      destructiveCode: segs.some((s) => s.destructiveCode),
      paths: segs.filter((s) => s.mutating).flatMap((s) => s.paths),
      deletes: segs.flatMap((s) => s.deletes || []),
      maybeDeletes: segs.flatMap((s) => s.maybeDeletes || []),
      soft,
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
    else if (c === '[' && glob.indexOf(']', i + 2) !== -1) {
      const j = glob.indexOf(']', i + 2);
      re += `[${glob.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = j;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
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
  if (/[*?[]/.test(absPath)) {
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
// The program must be the segment's command (after wrappers like sudo) and the
// second word its first argument, so `git log --grep="git push origin main"` and
// `git commit -m "never git push"` do not match. Nested shells and eval are followed.
function commandMatches(command, ruleCmd, depth = 0) {
  if (!ruleCmd || depth > 3) return false;
  const want = ruleCmd.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith('-'));
  if (!want.length) return false;
  return segments(command).some((seg) => {
    const words = seg.filter((w) => w !== '>');
    const k = commandStart(words);
    const name = path.basename(words[k] || '').toLowerCase();
    const args = words.slice(k + 1);
    if (name === 'eval') return commandMatches(args.join(' '), ruleCmd, depth + 1);
    if (SHELLS.test(name)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (ci !== -1 && args[ci + 1]) return commandMatches(args[ci + 1], ruleCmd, depth + 1);
    }
    if (name !== want[0]) return false;
    // skip option values like `git -C dir` before the subcommand
    let rest = args.map((w) => w.toLowerCase());
    if (name === 'git') { const i = rest.findIndex((w, j) => !w.startsWith('-') && !['-c', '-C'.toLowerCase()].includes(rest[j - 1])); rest = i === -1 ? [] : rest.slice(i); }
    const have = rest.filter((w) => !w.startsWith('-'));
    if (want.length === 1) return true;
    if (have[0] !== want[1]) return false;
    let i = 2;
    if (i === want.length) return true;
    for (const w of have.slice(1)) if (w === want[i] && ++i === want.length) return true;
    return false;
  });
}

// Files under a protected path whose names a `find -name` filter matches (bounded walk).
function protectedNameMatch(rulePath, root, names) {
  const staticPart = rulePath.replace(/^\.\//, '').split(/[*?]/)[0].replace(/\/+$/, '');
  const start = path.resolve(root, staticPart);
  const res = names.map((n) => (n.ci ? new RegExp(globToRegex(n.glob).source, 'i') : globToRegex(n.glob)));
  if (res.some((re) => re.test(path.basename(start)))) return true;
  const stack = [start];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      if (res.some((re) => re.test(e.name))) return true;
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(dir, e.name));
    }
  }
  return seen >= 5000 ? null : false;
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
    for (const m of hit ? [] : call.maybeDeletes || []) {
      const rp = (rule.paths || []).find((g) => deletionCovers(m.root, g, root));
      if (!rp) continue;
      const found = m.other ? null : protectedNameMatch(rp, root, m.names);
      if (found) { hit = `deletes files matching ${m.names.map((n) => n.glob).join(', ')} under ${path.relative(root, m.root) || '.'}, including in ${rp} (protected)`; break; }
      if (found === null) { opaqueHit = true; call.uncertain = true; }
    }
    if (!hit && (call.soft || []).some((p) => (rule.paths || []).some((g) => pathMatches(p, g, root)))) opaqueHit = true;
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
