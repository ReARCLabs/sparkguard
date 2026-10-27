#!/usr/bin/env node
'use strict';
// Detached background router: routes one queued prompt, records any rule, exits.
const fs = require('fs');
const { run } = require('../lib/background');

const job = process.argv[2];
// Hard stop: never linger, and never leave the marker that makes the guard wait.
setTimeout(() => { try { fs.unlinkSync(job); } catch { /* gone */ } process.exit(0); }, 10000).unref();
run(job).catch(() => {}).finally(() => { try { fs.unlinkSync(job); } catch { /* gone */ } process.exit(0); });
