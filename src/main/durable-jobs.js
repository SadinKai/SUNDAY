'use strict';

const crypto = require('crypto');

const JOB_STATES = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  RETRY_WAIT: 'RETRY_WAIT',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
});

const FINAL_STATES = new Set([JOB_STATES.CANCELLED, JOB_STATES.SUCCEEDED, JOB_STATES.FAILED]);

class DurableJobSystem {
  constructor(options) {
    const opts = options || {};
    if (!opts.database) throw new Error('A transactional state database is required.');
    this.db = opts.database;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.schedule = typeof opts.schedule === 'function' ? opts.schedule : fn => queueMicrotask(fn);
    this.handlers = new Map();
    this.active = new Set();
    this.controllers = new Map();
  }

  register(type, handler, options) {
    if (!type || typeof handler !== 'function') throw new Error('Job type and handler are required.');
    this.handlers.set(String(type), {
      handler,
      maxAttempts: Math.max(1, Number(options && options.maxAttempts) || 1),
      retryDelayMs: Math.max(0, Number(options && options.retryDelayMs) || 0),
    });
  }

  start(type, input, options) {
    const kind = String(type || '');
    const registration = this.handlers.get(kind);
    if (!registration) throw new Error(`Unknown job type: ${kind}`);
    const idempotencyKey = String(options && options.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
      throw new Error('Idempotency key must be 8-128 safe characters.');
    }
    const result = this.db.transaction(() => {
      const indexKey = `${kind}:${idempotencyKey}`;
      const existingIndex = this.db.get('job-idempotency', indexKey, null);
      if (existingIndex.found && existingIndex.value && existingIndex.value.operationId) {
        const existing = this.db.get('jobs', existingIndex.value.operationId, null);
        if (existing.found) return { existing: true, job: existing.value };
      }
      const operationId = crypto.randomUUID();
      const at = new Date(this.now()).toISOString();
      const job = {
        operationId,
        type: kind,
        idempotencyKey,
        state: JOB_STATES.QUEUED,
        progress: { completed: 0, total: 1, message: 'Queued' },
        input,
        attempt: 0,
        attemptId: null,
        maxAttempts: registration.maxAttempts,
        result: null,
        error: null,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
      };
      this.db.put('jobs', operationId, job, { expectedRevision: 0 });
      this.db.put('job-idempotency', indexKey, { operationId }, { expectedRevision: 0 });
      return { existing: false, job };
    });
    if (!result.existing) this._schedule(result.job.operationId, 0);
    return this.get(result.job.operationId);
  }

  get(operationId) {
    const row = this.db.get('jobs', String(operationId || ''), null);
    return row.found ? Object.assign({ revision: row.revision }, row.value) : null;
  }

  list() {
    return this.db.list('jobs').map(row => Object.assign({ revision: row.revision }, row.value));
  }

  cancel(operationId) {
    const id = String(operationId || '');
    const updated = this.db.update('jobs', id, null, job => {
      if (!job) throw new Error('Unknown operation ID.');
      if (FINAL_STATES.has(job.state)) return job;
      job.state = JOB_STATES.CANCEL_REQUESTED;
      job.updatedAt = new Date(this.now()).toISOString();
      return job;
    });
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error('Durable job cancellation requested.'));
    }
    return Object.assign({ revision: updated.revision }, updated.value);
  }

  resumePending() {
    const resumed = [];
    for (const job of this.list()) {
      if ([JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.RETRY_WAIT, JOB_STATES.CANCEL_REQUESTED].includes(job.state)) {
        this.db.update('jobs', job.operationId, null, current => {
          if (current.state === JOB_STATES.CANCEL_REQUESTED) return current;
          current.state = JOB_STATES.QUEUED;
          current.attemptId = null;
          current.updatedAt = new Date(this.now()).toISOString();
          current.progress = Object.assign({}, current.progress, { message: 'Recovered after owner restart' });
          return current;
        });
        resumed.push(job.operationId);
        this._schedule(job.operationId, 0);
      }
    }
    return resumed;
  }

  _schedule(operationId, delayMs) {
    if (this.active.has(operationId)) return;
    this.active.add(operationId);
    const invoke = async () => {
      let retryDelay = null;
      try {
        retryDelay = await this._run(operationId);
      } catch (_) {
        // _run persists every expected failure. An unexpected infrastructure
        // error remains reconnect-visible as the last durable job state.
      } finally {
        this.active.delete(operationId);
      }
      if (Number.isFinite(retryDelay)) this._schedule(operationId, retryDelay);
    };
    if (delayMs > 0) {
      const timer = setTimeout(() => this.schedule(invoke), delayMs);
      if (timer.unref) timer.unref();
    } else {
      this.schedule(invoke);
    }
  }

  async _run(operationId) {
    const registrationJob = this.get(operationId);
    if (!registrationJob) return;
    const registration = this.handlers.get(registrationJob.type);
    if (!registration) {
      this._finish(operationId, null, JOB_STATES.FAILED, null, 'No handler is registered for this job type.');
      return;
    }
    if (registrationJob.state === JOB_STATES.CANCEL_REQUESTED) {
      this._finish(operationId, registrationJob.attemptId, JOB_STATES.CANCELLED, null, null);
      return;
    }
    if (FINAL_STATES.has(registrationJob.state)) return;
    const attemptId = crypto.randomUUID();
    const running = this.db.update('jobs', operationId, null, job => {
      if (!job || FINAL_STATES.has(job.state)) return job;
      job.state = JOB_STATES.RUNNING;
      job.attempt += 1;
      job.attemptId = attemptId;
      job.updatedAt = new Date(this.now()).toISOString();
      job.progress = Object.assign({}, job.progress, { message: `Attempt ${job.attempt}` });
      return job;
    }).value;
    if (!running || running.attemptId !== attemptId) return;
    const controller = new AbortController();
    this.controllers.set(operationId, controller);

    const context = {
      operationId,
      attempt: running.attempt,
      signal: controller.signal,
      reportProgress: (completed, total, message) => {
        this.db.update('jobs', operationId, null, job => {
          if (!job || job.attemptId !== attemptId || job.state !== JOB_STATES.RUNNING) return job;
          job.progress = {
            completed: Math.max(0, Number(completed) || 0),
            total: Math.max(1, Number(total) || 1),
            message: String(message || ''),
          };
          job.updatedAt = new Date(this.now()).toISOString();
          return job;
        });
      },
      isCancellationRequested: () => {
        const current = this.get(operationId);
        return !current || current.state === JOB_STATES.CANCEL_REQUESTED;
      },
    };

    try {
      const result = await registration.handler(running.input, context);
      if (context.isCancellationRequested()) {
        this._finish(operationId, attemptId, JOB_STATES.CANCELLED, null, null);
      } else {
        this._finish(operationId, attemptId, JOB_STATES.SUCCEEDED, result, null);
      }
    } catch (error) {
      const current = this.get(operationId);
      if (!current || current.attemptId !== attemptId) return;
      if (current.state === JOB_STATES.CANCEL_REQUESTED) {
        this._finish(operationId, attemptId, JOB_STATES.CANCELLED, null, null);
      } else if (current.attempt < current.maxAttempts) {
        this.db.update('jobs', operationId, null, job => {
          if (job.attemptId !== attemptId) return job;
          job.state = JOB_STATES.RETRY_WAIT;
          job.error = String(error && error.message || error);
          job.updatedAt = new Date(this.now()).toISOString();
          return job;
        });
        return registration.retryDelayMs;
      } else {
        this._finish(operationId, attemptId, JOB_STATES.FAILED, null, String(error && error.message || error));
      }
    } finally {
      if (this.controllers.get(operationId) === controller) this.controllers.delete(operationId);
    }
  }

  _finish(operationId, attemptId, state, result, error) {
    return this.db.update('jobs', operationId, null, job => {
      if (!job || FINAL_STATES.has(job.state)) return job;
      if (attemptId && job.attemptId !== attemptId) return job;
      job.state = state;
      job.result = result;
      job.error = error;
      job.updatedAt = new Date(this.now()).toISOString();
      job.finishedAt = job.updatedAt;
      if (state === JOB_STATES.SUCCEEDED) {
        job.progress = { completed: 1, total: 1, message: 'Completed' };
      }
      return job;
    }).value;
  }
}

module.exports = { DurableJobSystem, JOB_STATES, FINAL_STATES };
