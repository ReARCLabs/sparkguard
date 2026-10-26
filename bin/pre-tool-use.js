#!/usr/bin/env node
'use strict';
const { runHook } = require('../lib/io');
const { preToolUse } = require('../lib/decide');
runHook((p) => preToolUse(p));
