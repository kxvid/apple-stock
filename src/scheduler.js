// One check at a time; requests received during a check coalesce into one follow-up.
export class CheckScheduler {
  constructor({ check, intervalSeconds = 30, onError = () => {}, random = Math.random,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.check = check;
    this.intervalSeconds = Number.isFinite(Number(intervalSeconds)) ? Math.max(30, Number(intervalSeconds)) : 30;
    Object.assign(this, { onError, random, setTimer, clearTimer, now });
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
    try {
      await this.check();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      const delay = this.pending ? 0 : Math.max(30_000, this.intervalSeconds * 1000 * (0.85 + this.random() * 0.3));
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
