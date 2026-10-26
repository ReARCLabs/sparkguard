#!/usr/bin/env node
'use strict';
const { runHook } = require('../lib/io');
const { sessionStart } = require('../lib/sync');
runHook((p) => sessionStart(p));
