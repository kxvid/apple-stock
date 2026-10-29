import test from 'node:test';
import assert from 'node:assert/strict';
import { AppleStore } from '../src/apple.js';

test('warm storefront is reused, but changed products and expired catalogs reload', async () => {
  const store = new AppleStore({ country: 'us', product: 'iphone-duo' });
  let loads = 0;
  store.page = { isClosed: () => false };
  store.loadProductPage = async () => {
    loads++;
    store.loadedProductUrl = store.productUrl;
    store.loadedAt = Date.now();
  };
  await store.ensureProductPage();
  await store.ensureProductPage();
  assert.equal(loads, 1);
  store.product = 'iphone-17';
  await store.ensureProductPage();
  assert.equal(loads, 2);
  store.loadedAt = Date.now() - 300_001;
  await store.ensureProductPage();
  assert.equal(loads, 3);
  store.page = { isClosed: () => true };
  await store.ensureProductPage();
  assert.equal(loads, 4);
});
