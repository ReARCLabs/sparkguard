#!/usr/bin/env node
'use strict';
// Stop: remember the agent's last reply so a follow-up like "never delete this"
// can be resolved. Never blocks.
const { runHook } = require('../lib/io');
const session = require('../lib/session');
const { projectRoot } = require('../lib/paths');
runHook((p) => {
  session.recordAssistant(projectRoot(p.cwd), p.session_id, p.last_assistant_message);
  return {};
});
