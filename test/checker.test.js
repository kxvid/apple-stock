import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checker, defaultSettings, postalCodeFits, filterVariants, matchesFilters } from '../src/checker.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('country defaults from COUNTRY and is validated', () => {
  assert.equal(defaultSettings({}).country, 'ca');
  assert.equal(defaultSettings({ COUNTRY: 'US' }).country, 'us');
  assert.throws(() => defaultSettings({ COUNTRY: 'usa' }));
});

test('postal codes are checked against the country format', () => {
  assert.ok(postalCodeFits('M5V3L9', 'ca'));
  assert.ok(!postalCodeFits('10001', 'ca'));
  assert.ok(postalCodeFits('10001', 'us'));
  assert.ok(postalCodeFits('10001-1234', 'us'));
  assert.ok(!postalCodeFits('M5V3L9', 'us'));
  assert.ok(postalCodeFits('SW1A1AA', 'uk'));
});

test('switching country resets models and a postal code that no longer fits', async () => {
  const checker = new Checker({ env: { POSTAL_CODE: 'M5V 3L9' }, log: () => {} });
  checker.settings.model = 'MK244VC/A';
  assert.equal(await checker.updateSettings({ country: 'us' }), true);
  assert.equal(checker.settings.country, 'us');
  assert.equal(checker.settings.postalCode, '');
  assert.equal(checker.settings.model, 'all');
  await checker.updateSettings({ postalCode: '10001' });
  assert.equal(checker.settings.postalCode, '10001');
  checker.settings.postalCode = 'ABCDE';
  await assert.rejects(checker.checkOnce(), /valid zip code/);
  await assert.rejects(checker.updateSettings({ country: 'u$' }));
});

test('country update waits for an in-flight check before closing the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const checkGate = deferred();
  const closeCalls = [];
  checker.store = {
    country: 'ca',
    browser: {},
    async close() {
      closeCalls.push(this.country);
    },
    async listProducts() {
      return [];
    },
  };
  checker.loadVariants = async () => {};
  checker.runCheck = async () => checkGate.promise;

  const check = checker.check();
  const update = checker.updateSettings({ country: 'us' });
  await Promise.resolve();
  assert.deepEqual(closeCalls, []);
  assert.equal(checker.store.country, 'ca');
  assert.equal(checker.settings.country, 'ca');

  checkGate.resolve();
  await Promise.all([check, update]);
  assert.deepEqual(closeCalls, ['ca']);
  assert.equal(checker.store.country, 'us');
  assert.equal(checker.settings.country, 'us');
});

test('check requested during a country switch waits for matching settings and store', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const productsGate = deferred();
  const variantsGate = deferred();
  const variantsStarted = deferred();
  let runCheckCountry;
  checker.store = {
    country: 'ca',
    async close() {},
    async listProducts() {
      return productsGate.promise;
    },
  };
  checker.loadVariants = async () => {
    variantsStarted.resolve();
    await variantsGate.promise;
  };
  checker.runCheck = async () => {
    runCheckCountry = [checker.settings.country, checker.store.country];
  };

  const update = checker.updateSettings({ country: 'us' });
  await Promise.resolve();
  const check = checker.check();
  assert.equal(runCheckCountry, undefined);

  productsGate.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);
  await variantsStarted.promise;
  assert.equal(runCheckCountry, undefined);
  variantsGate.resolve();
  await Promise.all([update, check]);
  assert.deepEqual(runCheckCountry, ['us', 'us']);
});

test('queued updates and a check complete in call order', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const firstProducts = deferred();
  const secondProducts = deferred();
  const secondProductsStarted = deferred();
  const events = [];
  let listCount = 0;
  checker.store = {
    country: 'ca',
    async close() {},
    async listProducts() {
      listCount++;
      events.push(`products:${this.country}`);
      if (listCount === 2) secondProductsStarted.resolve();
      return listCount === 1 ? firstProducts.promise : secondProducts.promise;
    },
  };
  checker.loadVariants = async () => {
    events.push(`variants:${checker.store.country}`);
  };
  checker.runCheck = async () => {
    events.push(`check:${checker.settings.country}:${checker.store.country}`);
  };

  const first = checker.updateSettings({ country: 'us' });
  const second = checker.updateSettings({ country: 'ca' });
  const check = checker.check();
  firstProducts.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);
  await secondProductsStarted.promise;
  assert.deepEqual(events, ['products:us', 'variants:us', 'products:ca']);
  secondProducts.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);

  await Promise.all([first, second, check]);
  assert.deepEqual(events, [
    'products:us',
    'variants:us',
    'products:ca',
    'variants:ca',
    'check:ca:ca',
  ]);
});

test('failed settings updates do not block later updates or pending checks', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const events = [];
  checker.runCheck = async () => {
    events.push(`check:${checker.settings.emailTo}`);
  };

  const failedUpdate = checker.updateSettings({ country: 'u$' });
  const check = checker.check();
  const validUpdate = checker.updateSettings({ emailTo: 'stock@example.com' });

  await assert.rejects(failedUpdate, /unsupported country/);
  await Promise.all([check, validUpdate]);
  assert.equal(checker.settings.emailTo, 'stock@example.com');
  assert.deepEqual(events, ['check:']);
});

test('empty UK postal code is rejected before opening the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  let opened = false;
  checker.settings.country = 'uk';
  checker.settings.postalCode = '';
  checker.store = {
    async open() {
      opened = true;
    },
  };

  await assert.rejects(checker.checkOnce(), /valid postal code/);
  assert.equal(opened, false);
});

test('exact variant filters fail closed when a dimension or model is missing', () => {
  const filters = { dimensionColor: ['starwhite'], dimensionCapacity: ['512gb'] };
  const models = [
    { partNumber: 'WHITE', dims: { dimensionColor: 'starwhite', dimensionCapacity: '512gb' } },
    { partNumber: 'UNKNOWN', dims: { dimensionCapacity: '512gb' } },
  ];
  assert.equal(matchesFilters(models[1], filters), false);
  const products = models.map(({ partNumber }) => ({ partNumber })).concat({ partNumber: 'NOT-IN-SELECTOR' });
  assert.deepEqual(filterVariants(products, { models }, filters), [{ partNumber: 'WHITE' }]);
  assert.deepEqual(filterVariants(products, null, filters), []);
  assert.deepEqual(filterVariants(products, null, {}), products);
});

test('changing a stock setting immediately invalidates previously available results', async () => {
  for (const update of [{ postalCode: '10001' }, { model: '512GB White' }, { filters: { dimensionColor: ['starwhite'] } }, { maxDistanceKm: 80 }]) {
    const checker = new Checker({ env: { COUNTRY: 'us', POSTAL_CODE: '91773' }, log: () => {} });
    checker.lastChecked = new Date().toISOString();
    checker.models = [{ partNumber: 'P', hit: true }];
    checker.availability = { pickup: [{ partNumber: 'P', available: true }], delivery: [] };
    await checker.updateSettings(update);
    assert.equal(checker.lastChecked, null);
    assert.deepEqual(checker.models, []);
    assert.deepEqual(checker.availability, { pickup: [], delivery: [] });
  }
});

test('combined country and filter saves preserve the newly supplied exact selection', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const filters = { dimensionColor: ['starwhite'], dimensionCapacity: ['512gb'] };
  await checker.updateSettings({ country: 'us', postalCode: '91773', model: '512GB White', filters });
  assert.deepEqual(checker.settings.filters, filters);
  assert.equal(checker.settings.model, '512GB White');
});

test('invalid distance cannot silently bypass the maximum radius', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  for (const maxDistanceKm of [-1, 0, 'bad', Infinity, 1001, null, true, [], {}, '']) {
    await assert.rejects(checker.updateSettings({ maxDistanceKm }), /search distance/);
  }
  for (const MAX_DISTANCE_KM of ['unknown', 'Infinity', '-5', '1001']) {
    assert.throws(() => defaultSettings({ MAX_DISTANCE_KM }), /search distance/);
  }
});

test('corrupt persisted settings are ignored atomically and snapshots remain readable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-stock-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsFile = join(directory, 'settings.json');
  for (const malformed of [
    { filters: { dimensionColor: null } },
    { filters: { dimensionColor: ['starwhite', null] } },
    { filters: null },
    { model: {} },
    { maxDistanceKm: 'unknown' },
    { maxDistanceKm: null },
    { maxDistanceKm: 1001 },
    { postalCode: [] },
  ]) {
    await writeFile(settingsFile, JSON.stringify({ country: 'ca', ...malformed }));
    const logs = [];
    const checker = new Checker({ env: { COUNTRY: 'us', POSTAL_CODE: '91773' }, settingsFile, log: (message) => logs.push(message) });
    checker.loadProducts = async () => {};
    checker.loadVariants = async () => {};
    await checker.init();
    assert.equal(checker.settings.country, 'us');
    assert.equal(checker.settings.maxDistanceKm, 50);
    assert.equal(checker.snapshot().settings.postalCode, '91773');
    assert.ok(logs[0].startsWith('ignoring '));
  }
});

test('malformed filter updates cannot silently broaden a saved exact selection', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  await checker.updateSettings({ filters: { dimensionColor: ['starwhite'] } });
  for (const filters of [null, [], { dimensionColor: 'starwhite' }, { dimensionColor: [null] }, { colour: ['starwhite'] }]) {
    await assert.rejects(checker.updateSettings({ filters }), /filter/);
    assert.deepEqual(checker.settings.filters, { dimensionColor: ['starwhite'] });
  }
});

test('legacy persisted color-only filters migrate without needing capacity filters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-stock-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsFile = join(directory, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ colors: ['starwhite'] }));
  const checker = new Checker({ env: {}, settingsFile, log: () => {} });
  checker.loadProducts = async () => {};
  checker.loadVariants = async () => {};
  await checker.init();
  assert.deepEqual(checker.settings.filters, { dimensionColor: ['starwhite'] });
});
