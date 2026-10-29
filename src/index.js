import { Checker } from './checker.js';
import { configuredNotifiers, notifyAll } from './notify.js';
import { PushStore } from './push.js';
import { startServer } from './server.js';
import { CheckScheduler } from './scheduler.js';

const args = new Set(process.argv.slice(2));
const env = process.env;
const log = (...m) => console.log(new Date().toISOString(), ...m);

async function main() {
  const push = await new PushStore({
    env,
    keysFile: env.VAPID_FILE || '.vapid.json',
    subscriptionsFile: env.SUBSCRIPTIONS_FILE || 'subscriptions.json',
    log,
  }).init();

  if (args.has('--test-notify')) {
    const notifiers = configuredNotifiers(env, { push });
    if (notifiers.length === 0) {
      throw new Error('No notifier configured; turn on notifications in the UI or set RESEND_API_KEY+EMAIL_TO, NTFY_TOPIC or DISCORD_WEBHOOK_URL');
    }
    const ok = await notifyAll(notifiers, { subject: 'apple-stock test notification', text: 'Notifications are working.' }, log);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const once = args.has('--once');
  const checker = new Checker({
    env,
    settingsFile: env.SETTINGS_FILE || 'settings.json',
    stateFile: env.STATE_FILE || '.state.json',
    headless: env.HEADLESS !== 'false',
    dryRun: args.has('--dry-run'),
    log,
    push,
  });
  if (once) {
    try {
      await checker.init();
      await checker.check();
      if (checker.error) process.exitCode = 1;
    } finally {
      await checker.close();
    }
    return;
  }

  let initializing = true;
  let server;
  const scheduler = new CheckScheduler({
    check: () => checker.check(),
    intervalSeconds: env.INTERVAL_SECONDS || 30,
    onError: (error) => { checker.error = error.message; log(`check failed: ${error.message}`); },
  });
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    // A stalled upstream request must not keep the local service alive after stop.
    const forcedExit = setTimeout(() => { server?.closeAllConnections(); process.exit(code); }, 5000);
    forcedExit.unref();
    const closed = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
    server?.closeIdleConnections();
    await checker.close().catch(() => {});
    await closed;
    clearTimeout(forcedExit);
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  // The dashboard is immediately reachable while Apple's catalog is loading.
  if (!args.has('--no-ui')) {
    server = startServer(checker, {
      host: env.HOST || '127.0.0.1',
      port: Number(env.PORT || 4321),
      log,
      allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((host) => host.trim()).filter(Boolean),
      runtime: () => ({ initializing, intervalSeconds: scheduler.intervalSeconds, nextCheckAt: scheduler.nextCheckAt }),
      onSettingsChanged: () => scheduler.requestCheck(),
    });
    server.on('error', (error) => {
      log(`server failed: ${error.message}`);
      void shutdown(1);
    });
  }
  try {
    await checker.init();
    initializing = false;
    if (checker.notifiers().length === 0) log('no notifier yet: turn on notifications in the UI or configure one in .env');
    scheduler.requestCheck();
  } catch (error) {
    log(`startup failed: ${error.message}`);
    await shutdown(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
