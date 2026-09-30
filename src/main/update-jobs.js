'use strict';

const UPDATE_CHECK_JOB = 'update-check';

function registerUpdateJobs(jobs, updater) {
  if (!jobs || typeof jobs.register !== 'function' || !updater || typeof updater.check !== 'function') {
    throw new Error('Update jobs require a durable job system and update coordinator.');
  }
  jobs.register(UPDATE_CHECK_JOB, async (_input, context) => {
    context.reportProgress(0, 1, 'Downloading and verifying signed update manifest');
    const status = await updater.check(context.signal);
    context.reportProgress(1, 1, 'Signed update manifest verified');
    return status;
  }, { maxAttempts: 2, retryDelayMs: 1000 });
}

function startUpdateCheck(jobs, idempotencyKey) {
  return jobs.start(UPDATE_CHECK_JOB, {}, { idempotencyKey });
}

module.exports = { UPDATE_CHECK_JOB, registerUpdateJobs, startUpdateCheck };
