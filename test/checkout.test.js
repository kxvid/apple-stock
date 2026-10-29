import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSummary, purchaseLinks, STOCK_FRESHNESS_MS } from '../src/checkout.js';

const productUrl = 'https://www.apple.com/shop/buy-iphone/iphone-duo';
const partNumber = 'MK1G4LL/A';
const token = '7.6-inch-display-512gb-star-white-unlocked';
const html = (products) => `PRODUCT_SELECTION_BOOTSTRAP productSelectionData: ${JSON.stringify({ products })}`;

test('purchase links use the observed variant token and prefer unlocked', () => {
  const links = purchaseLinks(html([
    { partNumber, seoUrlToken: '7.6-inch-display-512gb-star-white-att', isCarrierDevice: true },
    { partNumber, seoUrlToken: token, isCarrierDevice: false },
    { partNumber, seoUrlToken: '7.6-inch-display-512gb-star-white-verizon', isCarrierDevice: true },
  ]), productUrl);
  assert.equal(links[partNumber].purchaseUrl, `${productUrl}/${token}`);
  assert.equal(links[partNumber].exactUrl, true);
});

test('missing or unsafe variant tokens never pretend to be exact checkout links', () => {
  for (const seoUrlToken of ['', '../wrong', '//evil.example/path', 'foo?store=123', 'javascript:alert(1)']) {
    const links = purchaseLinks(html([{ partNumber, seoUrlToken }]), productUrl);
    assert.equal(links[partNumber].purchaseUrl, productUrl);
    assert.equal(links[partNumber].exactUrl, false);
  }
  assert.deepEqual(purchaseLinks(html([{ partNumber, seoUrlToken: token }]), 'https://example.com'), {});
});

const now = Date.parse('2026-10-29T12:00:00Z');
const model = { partNumber, name: 'iPhone Duo 512GB Star White', purchaseUrl: `${productUrl}/${token}`, exactUrl: true };
const nearby = { partNumber, storeName: 'Nearby', storeNumber: 'R1', distance: '5 mi', distanceKm: 8.05, available: true };
const farther = { ...nearby, storeName: 'Farther', storeNumber: 'R2', distance: '15 mi', distanceKm: 24.14 };
const input = () => ({
  selectedModels: [model],
  availability: { pickup: [farther, nearby], delivery: [] },
  lastChecked: new Date(now).toISOString(),
  error: null,
  now,
});

test('ready handoff chooses the nearest available store for the exact variant', () => {
  const result = checkoutSummary(input());
  assert.equal(result.ready, true);
  assert.equal(result.fulfillment, 'pickup');
  assert.equal(result.preferredStore.storeNumber, 'R1');
  assert.equal(result.purchaseUrl, model.purchaseUrl);
  assert.equal(result.expiresAt, new Date(now + STOCK_FRESHNESS_MS).toISOString());
});

test('wrong variants, unknown distances and unavailable stores cannot become a preferred pickup', () => {
  const data = input();
  data.availability.pickup = [
    { ...nearby, partNumber: 'WRONG' },
    { ...nearby, distanceKm: NaN },
    { ...nearby, available: false },
  ];
  const result = checkoutSummary(data);
  assert.equal(result.ready, false);
  assert.equal(result.status, 'waiting');
  assert.equal(result.preferredStore, null);
});

test('expired and failed stock never arm handoff even when previous pickup was available', () => {
  for (const data of [
    { ...input(), lastChecked: new Date(now - STOCK_FRESHNESS_MS - 1).toISOString() },
    { ...input(), lastChecked: new Date(now + 1).toISOString() },
    { ...input(), error: 'Apple is unavailable' },
  ]) {
    const result = checkoutSummary(data);
    assert.equal(result.ready, false);
    assert.equal(result.preferredStore, null);
    assert.equal(result.fulfillment, null);
  }
});

test('courier availability is a fallback, not regular shipping or buyability', () => {
  const data = input();
  data.availability.pickup = [];
  data.availability.delivery = [{ partNumber, courierAvailable: false, buyable: true, shipText: 'Tomorrow' }];
  assert.equal(checkoutSummary(data).status, 'waiting');
  data.availability.delivery[0].courierAvailable = true;
  assert.equal(checkoutSummary(data).fulfillment, 'courier');
});

test('multiple selections and missing exact links require an explicit model choice', () => {
  const data = input();
  data.selectedModels.push({ ...model, partNumber: 'SECOND' });
  assert.equal(checkoutSummary(data).status, 'choose-model');
  assert.equal(checkoutSummary(data).purchaseUrl, null);
  data.selectedModels = [{ ...model, exactUrl: false }];
  assert.equal(checkoutSummary(data).ready, false);
  assert.equal(checkoutSummary(data).status, 'choose-model');
});
