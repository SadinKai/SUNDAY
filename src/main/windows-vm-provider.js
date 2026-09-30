'use strict';

const {
  EnvironmentProvider,
  PROVIDER_STATES,
  providerResult,
} = require('./environment-provider');

const DEFAULT_REASON = 'No supported Windows VM management provider is present on this host; live environment operations are unavailable.';

/**
 * Provider-neutral Windows VM contract. Concrete implementations must be
 * supplied only after a provider and disposable qualification host exist.
 * This class never enables Windows features, installs software, creates a VM,
 * or falls back to host process manipulation.
 */
class WindowsVmProvider extends EnvironmentProvider {
  constructor(options) {
    const opts = options || {};
    super({ providerId: opts.providerId || 'windows-vm-unavailable' });
    this.reason = String(opts.reason || DEFAULT_REASON);
    this.discovery = Object.freeze(Object.assign({
      windowsEdition: 'UNKNOWN',
      windowsVersion: 'UNKNOWN',
      virtualizationFirmwareEnabled: false,
      hypervisorPresent: false,
      hyperVManagement: false,
      hyperVService: false,
      virtualBoxManagement: false,
      vmwareManagement: false,
      totalMemoryBytes: null,
      freeStorageBytes: null,
      networkObserved: false,
      graphicsAdapters: [],
      providerVersion: null,
      mutatingProbePerformed: false,
    }, opts.discovery || {}));
  }

  async discover() {
    return providerResult(PROVIDER_STATES.PROVIDER_UNAVAILABLE, this.reason, {
      providerId: this.providerId,
      provider: null,
      available: false,
      supported: false,
      canCreateGuests: false,
      canProvideInteractiveGraphics: false,
      discovery: this.discovery,
    });
  }

  async preflight() { return this.discover(); }

  async _unavailable() {
    return providerResult(PROVIDER_STATES.PROVIDER_UNAVAILABLE, this.reason, {
      providerId: this.providerId,
    });
  }

  async provision() { return this._unavailable(); }
  async allocate() { return this._unavailable(); }
  async start() { return this._unavailable(); }
  async connect() { return this._unavailable(); }
  async health() { return this._unavailable(); }
  async executeLaunchIntent() { return this._unavailable(); }
  async observe() { return this._unavailable(); }
  async stop() { return this._unavailable(); }
  async restart() { return this._unavailable(); }
  async release() { return this._unavailable(); }
  async destroy() { return this._unavailable(); }
  async recover() { return this._unavailable(); }
}

module.exports = { DEFAULT_REASON, WindowsVmProvider };
