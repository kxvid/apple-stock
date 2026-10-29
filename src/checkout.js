import { productSelectionData } from './parse.js';

export const STOCK_FRESHNESS_MS = 90_000;

// These are Apple's own variant tokens, not constructed checkout parameters.
// A page without a token still gets a useful product-page fallback, but it
// cannot arm the exact-configuration shortcut.
export function purchaseLinks(html, productUrl) {
  const base = new URL(productUrl);
  if (base.protocol !== 'https:' || base.hostname !== 'www.apple.com') return {};
  const products = productSelectionData(html)?.products ?? [];
  const links = {};
  for (const product of products) {
    const partNumber = product.partNumber ?? product.btrOrFdPartNumber;
    if (!partNumber) continue;
    const token = product.seoUrlToken;
    const exactUrl = typeof token === 'string' && /^[a-z0-9][a-z0-9.-]*$/i.test(token);
    const previous = links[partNumber];
    if (previous && (!previous.isCarrierDevice || product.isCarrierDevice)) continue;
    links[partNumber] = {
      purchaseUrl: exactUrl ? `${base.origin}${base.pathname.replace(/\/$/, '')}/${token}` : base.href,
      exactUrl,
      isCarrierDevice: Boolean(product.isCarrierDevice),
    };
  }
  return links;
}

export function checkoutSummary({ selectedModels, availability, lastChecked, error, now = Date.now(), freshnessMs = STOCK_FRESHNESS_MS }) {
  const checked = Date.parse(lastChecked);
  const hasCheck = Number.isFinite(checked);
  const stale = !hasCheck || now - checked > freshnessMs || checked > now;
  const selectedModel = selectedModels.length === 1 ? selectedModels[0] : null;
  const stores = selectedModel ? availability.pickup
    .filter((store) => store.partNumber === selectedModel.partNumber)
    .sort((a, b) => (Number.isFinite(a.distanceKm) ? a.distanceKm : Infinity) - (Number.isFinite(b.distanceKm) ? b.distanceKm : Infinity)
      || String(a.storeName).localeCompare(String(b.storeName))) : [];
  const fresh = !stale && !error;
  // Unknown distances cannot establish that a store is inside the radius.
  const preferredStore = fresh ? stores.find((store) => store.available && Number.isFinite(store.distanceKm)) ?? null : null;
  const courier = fresh && selectedModel ? availability.delivery.find((entry) => entry.partNumber === selectedModel.partNumber && entry.courierAvailable) : null;
  const fulfillment = preferredStore ? 'pickup' : courier ? 'courier' : null;
  let status;
  let reason;
  if (error) {
    status = 'error';
    reason = `Stock could not be verified: ${error}`;
  } else if (selectedModels.length === 0) {
    status = 'no-match';
    reason = 'No model matches your selection. Check the colour and capacity filters.';
  } else if (!selectedModel) {
    status = 'choose-model';
    reason = 'Choose one configuration to prepare an exact Apple handoff.';
  } else if (!hasCheck) {
    status = 'unchecked';
    reason = 'Your selection is saved. Waiting for the first stock check.';
  } else if (stale) {
    status = 'stale';
    reason = 'The last stock result has expired. Check again before continuing.';
  } else if (!fulfillment) {
    status = 'waiting';
    reason = 'No pickup or 2-hour courier is available for this configuration in your search area.';
  } else if (!selectedModel.exactUrl) {
    status = 'choose-model';
    reason = 'Stock is available. Apple did not provide an exact variant link; choose the configuration on Apple.';
  } else {
    status = 'ready';
    reason = preferredStore ? `Nearest pickup: ${preferredStore.storeName} (${preferredStore.distance}).` : '2-hour courier is available for your selection.';
  }
  return {
    status,
    ready: status === 'ready',
    reason,
    stale,
    checkedAt: lastChecked,
    expiresAt: hasCheck ? new Date(checked + freshnessMs).toISOString() : null,
    selectedModels,
    selectedModel,
    purchaseUrl: selectedModel?.purchaseUrl ?? null,
    preferredStore,
    fulfillment,
    stores,
  };
}
