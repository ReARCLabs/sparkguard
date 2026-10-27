'use strict';
// A small cross-process lock. Hooks run as separate processes (and the background
// router runs beside them), so read-modify-write of shared JSON needs one. mkdir is
// atomic; a lock older than staleMs belongs to a crashed holder and is taken over.
const fs = require('fs');

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn, { waitMs = 2000, staleMs = 10000 } = {}) {
  const dir = `${file}.lock`;
  const end = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try { fs.mkdirSync(dir); held = true; } catch (e) {
      if (e.code !== 'EEXIST') break;
      let stale = false;
      try { stale = Date.now() - fs.statSync(dir).mtimeMs > staleMs; } catch { /* just released */ }
      if (stale) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* raced */ } }
      // Never block the agent for long: after waitMs, go ahead without the lock.
      if (Date.now() > end) break;
      if (!stale) pause(15);
    }
  }
  try { return fn(); } finally { if (held) try { fs.rmdirSync(dir); } catch { /* gone */ } }
}

module.exports = { withLock, pause };
