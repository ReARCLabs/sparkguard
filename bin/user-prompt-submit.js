#!/usr/bin/env node
'use strict';
const { runHook } = require('../lib/io');
const { userPromptSubmit } = require('../lib/prompt');
runHook((p) => userPromptSubmit(p));
