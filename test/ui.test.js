import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// A small DOM double exercises browser state transitions without Apple calls,
// pop-ups, notification permissions, or real purchase navigation.
function harness({ offline = false } = {}) {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.hidden = false; this.value = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    querySelector() { return this.children[0] || null; }
  }
  const nodes = new Map();
  const document = {
    activeElement: null,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); },
    createElement(tag) { return new Element(tag); },
  };
  const windows = [];
  const window = {
    addEventListener() {},
    open(url) {
      const popup = { closed: false, document: { ...document, body: new Element('body') },
        location: { href: url, replace(next) { this.href = next; popup.navigations++; } },
        navigations: 0, focus() {}, close() { this.closed = true; } };
      windows.push(popup); return popup;
    },
  };
  const context = vm.createContext({ document, window, navigator: {userAgent:'Test'},
    matchMedia:()=>({matches:false}), fetch:()=>offline ? Promise.reject(new Error('offline')) : new Promise(()=>{}),
    AbortSignal, URL, Date, Intl, Uint8Array, crypto:globalThis.crypto,
    setTimeout:()=>0, clearTimeout(){}, setInterval(){}, console,
  });
  vm.runInContext(script, context);
  return { context, windows, node:id=>document.getElementById(id), run:code=>vm.runInContext(code,context) };
}
function snapshot() {
  const checkedAt = new Date().toISOString();
  const model = {partNumber:'EXACT',name:'iPhone Duo 512GB Star White',price:2199,exactUrl:true,purchaseUrl:'https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-512gb-star-white-unlocked'};
  return {
    settings:{country:'us',product:'buy-iphone/iphone-duo',model:'all',filters:{},postalCode:'10001',maxDistanceKm:80},
    products:[{slug:'buy-iphone/iphone-duo',name:'iPhone Duo'}],countries:[{id:'us',name:'United States',postal:'ZIP code'}],
    variants:{models:[],dimensions:[]},checkout:{status:'waiting',ready:false,stale:false,checkedAt,expiresAt:new Date(Date.now()+90_000).toISOString(),selectedModel:model,selectedModels:[model],purchaseUrl:model.purchaseUrl,stores:[]},
    availability:{pickup:[],delivery:[]},lastChecked:checkedAt,
  };
}
function setState(h, value) { h.context.fixture = value; h.run('state = fixture; networkError = ""; render();'); }
function arm(h) { h.node('arm').checked = true; h.run("$('arm').onchange()"); }

test('initial connection failure renders a useful error without a state object', async () => {
  const h = harness({offline:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.node('errorBanner').hidden, false);
  assert.match(h.node('errorText').textContent, /Cannot reach your local monitor/);
  assert.equal(h.node('readyTitle').textContent, 'Start your monitor to continue');
});

test('available stock never navigates without explicit arming', () => {
  const h = harness(), data = snapshot(); data.checkout.ready = true; data.checkout.status = 'ready';
  setState(h,data); h.run('render()');
  assert.equal(h.windows.length,0);
});

test('an armed waiting tab navigates exactly once when fresh stock arrives', () => {
  const h = harness(); setState(h,snapshot()); arm(h);
  assert.equal(h.windows.length,1);
  assert.equal(h.windows[0].location.href,'about:blank');
  h.run('state.checkout.ready = true; state.checkout.status = "ready"; render(); render();');
  assert.match(h.windows[0].location.href,/512gb-star-white-unlocked$/);
  assert.equal(h.windows[0].navigations,1);
  assert.equal(h.node('arm').checked,false);
});

for (const [name, change] of [
  ['expired availability', 'state.checkout.expiresAt = new Date(Date.now()-1000).toISOString()'],
  ['Apple errors', 'state.error = "Apple unavailable"'],
  ['location changes', 'state.settings.postalCode = "90210"'],
  ['a disconnected monitor', 'networkError = "offline"'],
]) {
  test(`automatic opening disarms on ${name}`, () => {
    const h = harness(); setState(h,snapshot()); arm(h);
    h.run(`${change}; state.checkout.ready = true; render();`);
    assert.equal(h.windows[0].navigations,0);
    assert.equal(h.windows[0].closed,true);
    assert.equal(h.node('arm').checked,false);
  });
}

test('a non-Apple link cannot become the purchase target', () => {
  const h = harness(), data = snapshot(); data.checkout.purchaseUrl='https://apple.com.attacker.example/checkout';
  setState(h,data);
  assert.equal(h.node('purchase').getAttribute('aria-disabled'),'true');
  assert.equal(h.node('arm').disabled,true);
});
