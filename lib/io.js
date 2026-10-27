'use strict';
// Shared hook runner: read one JSON payload on stdin, write one JSON result on stdout.
// Any internal error fails open ({}), so Sparkguard can never wedge the agent.
async function runHook(handler) {
  // Concatenate bytes before decoding: a multi-byte character can straddle two chunks.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  let out = {};
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    out = (await handler(payload)) || {};
  } catch (e) {
    if (process.env.SPARKGUARD_DEBUG) process.stderr.write(`sparkguard: ${e.stack || e}\n`);
    out = {};
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
module.exports = { runHook };
