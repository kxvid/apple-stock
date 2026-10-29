import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckScheduler } from '../src/scheduler.js';

function setup(check = async () => {}, options = {}) {
  const jobs = new Map();
  let id = 0;
  const scheduler = new CheckScheduler({
    check, random: () => 0, now: () => 0,
    setTimer: (fn, delay) => { jobs.set(++id, { fn, delay }); return id; },
    clearTimer: (timer) => jobs.delete(timer), ...options,
  });
  const runNext = () => {
    const [id, job] = jobs.entries().next().value;
    jobs.delete(id);
    return job.fn();
  };
  return { scheduler, jobs, runNext };
}

test('repeated pending requests coalesce and jitter never drops below 30 seconds', async () => {
  let checks = 0;
  const { scheduler, jobs, runNext } = setup(async () => { checks++; });
  scheduler.requestCheck();
  scheduler.requestCheck();
  assert.equal(jobs.size, 1);
  await runNext();
  assert.equal(checks, 1);
  assert.equal(jobs.size, 1);
  assert.equal([...jobs.values()][0].delay, 30_000);
  assert.equal(scheduler.nextCheckAt, '1970-01-01T00:00:30.000Z');
});

test('requests while checking queue one follow-up without parallel checks', async () => {
  let resolve;
  let checks = 0;
  const gate = new Promise((r) => { resolve = r; });
  const { scheduler, jobs, runNext } = setup(async () => { checks++; await gate; });
  scheduler.requestCheck();
  const first = runNext();
  scheduler.requestCheck();
  scheduler.requestCheck();
  assert.equal(checks, 1);
  assert.equal(jobs.size, 0);
  resolve();
  await first;
  assert.equal(jobs.size, 1);
  assert.equal([...jobs.values()][0].delay, 0);
  await runNext();
  assert.equal(checks, 2);
  assert.equal([...jobs.values()][0].delay, 30_000);
});

test('stop during a check prevents timers from being restarted', async () => {
  let resolve;
  const gate = new Promise((r) => { resolve = r; });
  const { scheduler, jobs, runNext } = setup(() => gate);
  scheduler.requestCheck();
  const running = runNext();
  scheduler.requestCheck();
  scheduler.stop();
  resolve();
  await running;
  scheduler.requestCheck();
  assert.equal(jobs.size, 0);
  assert.equal(scheduler.nextCheckAt, null);
});

test('check failure is reported and recurring schedule recovers', async () => {
  const errors = [];
  const { scheduler, jobs, runNext } = setup(async () => { throw new Error('network'); }, { onError: (error) => errors.push(error.message), intervalSeconds: 'invalid' });
  scheduler.requestCheck();
  await runNext();
  assert.deepEqual(errors, ['network']);
  assert.equal(scheduler.intervalSeconds, 30);
  assert.equal(jobs.size, 1);
});
