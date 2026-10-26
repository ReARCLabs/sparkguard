#!/usr/bin/env node
'use strict';
// Detached outbox flusher (started by the hooks). Exits quietly on any error.
require('../lib/mirror').flush().then(() => process.exit(0), () => process.exit(0));
