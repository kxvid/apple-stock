import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckScheduler } from '../src/scheduler.js';

function setup(check = async () => {}, options = {}) {
  const jobs = new Map();
  let id = 0;
  let clock = 0;
  const scheduler = new CheckScheduler({
    check, now: () => clock,
    setTimer: (fn, delay) => { jobs.set(++id, { fn, delay, at: clock + delay }); return id; },
    clearTimer: (timer) => jobs.delete(timer), ...options,
  });
  const runNext = () => {
    const [id, job] = jobs.entries().next().value;
    jobs.delete(id);
    clock = Math.max(clock, job.at);
    return job.fn();
  };
  return { scheduler, jobs, runNext, now: () => clock, advanceBy: (ms) => { clock += ms; } };
}

test('requests coalesce and scans start on a fixed 30-second cadence without runtime drift', async () => {
  const starts = [];
  const clock = setup(async () => { starts.push(clock.now()); clock.advanceBy(7_000); });
  const { scheduler, jobs, runNext } = clock;
  scheduler.requestCheck();
  scheduler.requestCheck();
  assert.equal(jobs.size, 1);
  await runNext();
  assert.equal([...jobs.values()][0].delay, 23_000);
  assert.equal(scheduler.nextCheckAt, '1970-01-01T00:00:30.000Z');
  await runNext();
  await runNext();
  assert.deepEqual(starts, [0, 30_000, 60_000]);
  assert.equal(jobs.size, 1);
  assert.equal(scheduler.nextCheckAt, '1970-01-01T00:01:30.000Z');
});

test('slow scans skip missed slots without a catch-up burst or overlapping runs', async () => {
  const starts = [];
  const clock = setup(async () => { starts.push(clock.now()); clock.advanceBy(75_000); });
  clock.scheduler.requestCheck();
  await clock.runNext();
  assert.equal([...clock.jobs.values()][0].delay, 15_000);
  assert.equal(clock.scheduler.nextCheckAt, '1970-01-01T00:01:30.000Z');
  await clock.runNext();
  assert.deepEqual(starts, [0, 90_000]);
  assert.equal(clock.jobs.size, 1);
});

test('a scan finishing exactly on a slot can start the next scan at that slot', async () => {
  const clock = setup(async () => clock.advanceBy(30_000));
  clock.scheduler.requestCheck();
  await clock.runNext();
  assert.equal([...clock.jobs.values()][0].delay, 0);
  assert.equal(clock.scheduler.nextCheckAt, '1970-01-01T00:00:30.000Z');
});

test('requests while checking queue one follow-up without parallel checks and reset cadence', async () => {
  let resolve;
  const starts = [];
  const gate = new Promise((r) => { resolve = r; });
  const clock = setup(async () => { starts.push(clock.now()); await gate; });
  const { scheduler, jobs, runNext } = clock;
  scheduler.requestCheck();
  const first = runNext();
  scheduler.requestCheck();
  scheduler.requestCheck();
  assert.deepEqual(starts, [0]);
  assert.equal(jobs.size, 0);
  clock.advanceBy(8_000);
  resolve();
  await first;
  assert.equal(jobs.size, 1);
  assert.equal([...jobs.values()][0].delay, 0);
  await runNext();
  assert.deepEqual(starts, [0, 8_000]);
  assert.equal(scheduler.nextCheckAt, '1970-01-01T00:00:38.000Z');
});

test('manual check between scans replaces the timer and establishes a new cadence', async () => {
  const starts = [];
  const clock = setup(async () => starts.push(clock.now()));
  clock.scheduler.requestCheck();
  await clock.runNext();
  clock.advanceBy(10_000);
  clock.scheduler.requestCheck();
  assert.equal(clock.jobs.size, 1);
  await clock.runNext();
  assert.deepEqual(starts, [0, 10_000]);
  assert.equal(clock.scheduler.nextCheckAt, '1970-01-01T00:00:40.000Z');
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

test('check failure is reported and recurring schedule recovers at a fixed interval', async () => {
  const errors = [];
  const { scheduler, jobs, runNext } = setup(async () => { throw new Error('network'); }, { onError: (error) => errors.push(error.message), intervalSeconds: 'invalid' });
  scheduler.requestCheck();
  await runNext();
  assert.deepEqual(errors, ['network']);
  assert.equal(scheduler.intervalSeconds, 30);
  assert.equal(jobs.size, 1);
  assert.equal([...jobs.values()][0].delay, 30_000);
});
