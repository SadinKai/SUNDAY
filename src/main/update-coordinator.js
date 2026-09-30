'use strict';

const { fetchWithPolicy } = require('./http-policy');
const { parseAndVerifyManifest, verifyArtifactBuffer } = require('./release-trust');

class UpdateCoordinator {
  constructor(options) {
    const opts = options || {};
    this.currentVersion = String(opts.currentVersion || '0.0.0');
    this.database = opts.database;
    this.publicKeySpkiBase64 = String(opts.publicKeySpkiBase64 || '');
    this.publisher = String(opts.publisher || '');
    this.manifestUrl = String(opts.manifestUrl || '');
    this.applyAdapter = opts.applyAdapter || null;
    this.manifest = null;
    this.lastError = null;
    if (!this.database) throw new Error('Update coordinator requires transactional state.');
  }

  trustConfigured() {
    return !!(this.publicKeySpkiBase64 && this.publisher && this.manifestUrl);
  }

  applyConfigured() {
    return !!(this.trustConfigured()
      && this.applyAdapter
      && typeof this.applyAdapter.extract === 'function'
      && typeof this.applyAdapter.stage === 'function'
      && typeof this.applyAdapter.activate === 'function');
  }

  accepted() {
    return this.database.get('update-state', 'accepted', {
      version: this.currentVersion,
      releaseSequence: 0,
    }).value;
  }

  status() {
    const accepted = this.accepted();
    const available = this.manifest && this.manifest.releaseSequence > accepted.releaseSequence
      ? { version: this.manifest.version, releaseSequence: this.manifest.releaseSequence }
      : null;
    return {
      state: !this.trustConfigured() ? 'unavailable' : (available ? 'available' : 'current'),
      currentVersion: this.currentVersion,
      acceptedReleaseSequence: accepted.releaseSequence,
      available,
      applyReady: !!this.applyConfigured(),
      error: this.lastError,
    };
  }

  async check(signal) {
    if (!this.trustConfigured()) throw new Error('Signed update trust is not configured in this SUNDAY Launcher build.');
    try {
      const response = await fetchWithPolicy(this.manifestUrl, {
        headers: { Accept: 'application/json' },
        signal,
      }, 'updateFeed');
      if (!response.ok) throw new Error(`Update manifest request returned HTTP ${response.status}.`);
      const text = await response.text();
      this.manifest = parseAndVerifyManifest(text, {
        publicKeySpkiBase64: this.publicKeySpkiBase64,
        publisher: this.publisher,
        minimumSequence: Number(this.accepted().releaseSequence) || 0,
      });
      this.lastError = null;
      return this.status();
    } catch (error) {
      this.manifest = null;
      this.lastError = String(error && error.message || error);
      throw error;
    }
  }

  async install(signal, reportProgress) {
    if (!this.applyConfigured()) throw new Error('Update application is not configured in this SUNDAY Launcher build.');
    if (!this.manifest) throw new Error('No verified update manifest is available.');
    const artifact = this.manifest.artifacts.find(item => /\.zip$/i.test(item.name)) || this.manifest.artifacts[0];
    if (typeof reportProgress === 'function') reportProgress(0, 4, 'Downloading signed artifact');
    const response = await fetchWithPolicy(artifact.url, { signal }, 'updateArtifact');
    if (!response.ok) throw new Error(`Update artifact request returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyArtifactBuffer(bytes, artifact);
    if (typeof reportProgress === 'function') reportProgress(1, 4, 'Verifying and extracting candidate');
    const extracted = await this.applyAdapter.extract(bytes, artifact, this.manifest);
    if (typeof reportProgress === 'function') reportProgress(2, 4, 'Verifying Authenticode and candidate file set');
    const staged = await this.applyAdapter.stage(extracted, artifact, this.manifest);
    if (typeof reportProgress === 'function') reportProgress(3, 4, 'Starting health handshake');
    const result = await this.applyAdapter.activate(staged, this.manifest);
    if (!result || result.ok !== true) throw new Error(result && result.error || 'Candidate activation failed.');
    if (typeof reportProgress === 'function') reportProgress(4, 4, 'Activated');
    return result;
  }
}

module.exports = { UpdateCoordinator };
