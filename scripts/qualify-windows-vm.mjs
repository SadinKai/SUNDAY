#!/usr/bin/env node

'use strict';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WindowsVmProvider } = require('../src/main/windows-vm-provider');

if (process.argv.length !== 2) {
  console.error('REFUSED: the real VM qualification command accepts no live, force, unsafe, or provider-bypass flags.');
  process.exitCode = 2;
} else {
  const provider = new WindowsVmProvider({
    reason: 'No concrete provider is compiled for a provisioned disposable qualification host.',
  });
  const result = await provider.preflight();
  console.error(`REFUSED: ${result.state}: ${result.reason}`);
  console.error('Real VM qualification requires a separately provisioned disposable host, a supported concrete provider, signed guest-agent/image identities, GPU passthrough, and an explicit activation record.');
  process.exitCode = 2;
}
