// One check at a time; requests received during a check coalesce into one follow-up.
export class CheckScheduler {
  constructor({ check, intervalSeconds = 30, onError = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.check = check;
    this.intervalSeconds = Number.isFinite(Number(intervalSeconds)) ? Math.max(30, Number(intervalSeconds)) : 30;
    Object.assign(this, { onError, setTimer, clearTimer, now });
    this.running = false;
    this.pending = false;
    this.stopped = false;
    this.timer = null;
    this.nextCheckAt = null;
  }

  requestCheck() {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.schedule(0);
  }

  schedule(delay) {
    if (this.stopped) return;
    this.clearTimer(this.timer);
    this.nextCheckAt = new Date(this.now() + delay).toISOString();
    this.timer = this.setTimer(() => this.run(), delay);
  }

  async run() {
    if (this.stopped || this.running) return;
    this.timer = null;
    this.nextCheckAt = null;
    this.running = true;
    const startedAt = this.now();
    try {
      await this.check();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      const intervalMs = this.intervalSeconds * 1000;
      // Keep start-to-start cadence; skip slots missed by a slow check instead
      // of overlapping checks or replaying a backlog. Manual requests can run
      // once immediately afterward and establish a new cadence.
      const elapsed = this.now() - startedAt;
      const nextSlot = startedAt + Math.max(1, Math.ceil(elapsed / intervalMs)) * intervalMs;
      const delay = this.pending ? 0 : Math.max(0, nextSlot - this.now());
      this.pending = false;
      this.schedule(delay);
    }
  }

  stop() {
    this.stopped = true;
    this.pending = false;
    this.clearTimer(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
  }
}
