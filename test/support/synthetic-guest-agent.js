'use strict';

/** TEST ONLY: never copied into production artifacts. */

const { WindowsGuestAgent } = require('../../src/guest/windows-guest-agent');

class SyntheticGuestAgent extends WindowsGuestAgent {
  constructor(options) {
    super(Object.assign({}, options || {}, { syntheticTestOnly: true }));
    this.syntheticTestOnly = true;
  }
}

module.exports = { SyntheticGuestAgent };
