'use strict';
// Executes the actual frontend in Node with a minimal mocked DOM and XHR.
// This checks auth state transitions, not browser rendering, cookies, or installs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '..', 'service', 'public');
const source = fs.readFileSync(path.join(publicDir, 'phone.js'), 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const key = 'stillhome.phone.session';

function harness(options = {}) {
  const elements = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.scrollTop = 0;
      this.classList = { add() {}, remove() {}, toggle() {} }; this.style = {};
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || ''; }
    appendChild(child) { this.children.push(child); child.parentNode = child.parentElement = this; return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] || []) fn.call(this, { preventDefault() {}, key: '', target: this }); }
    focus() { document.activeElement = this; }
    select() {}
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || selector.split(', ').some(tag => child.tagName === tag.toUpperCase())); }
  }
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.id = match[2]; element.hidden = /\shidden(?:\s|>)/.test(match[0]); element.checked = /\schecked(?:\s|>)/.test(match[0]);
    element.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || ''; elements.set(element.id, element);
  }
  const fallback = new Element();
  elements.get('connection-label').parentElement = fallback;
  const document = {
    hidden: false, body: new Element(), activeElement: null, listeners: {},
    getElementById: id => { assert(elements.has(id), 'Known frontend element ' + id); return elements.get(id); },
    createElement: tag => new Element(tag), contains: () => true,
    querySelector: () => fallback,
    querySelectorAll(selector) { return selector.split(', ').flatMap(part => { const [id, tag] = part.split(' '); return id.startsWith('#') && elements.has(id.slice(1)) ? elements.get(id.slice(1)).querySelectorAll(tag) : []; }); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] || []) fn(); }
  };
  const stored = new Map(options.stored ? [[key, JSON.stringify(options.stored)]] : []);
  const sessionStorage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const fake = { remembered: !!options.remembered, token: options.stored?.token || '', serial: 0, calls: [], failSession: false, failForget: false, rejectState: 0 };
  const config = { revision: 1, appIds: null, dim: 0.32, wallpaper: null, wallpaperLibrary: [], defaultFocalPoint: null, temperatureUnit: 'fahrenheit', clock24: false };
  function issue(remembered) { fake.token = 'short-' + ++fake.serial; return { token: fake.token, expiresAt: Date.now() + 1800000, remembered }; }
  class XHR {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(raw) {
      const body = raw ? JSON.parse(raw) : {};
      fake.calls.push({ url: this.url, body, headers: this.headers });
      queueMicrotask(() => {
        if (this.url === '/api/session' && fake.failSession || this.url === '/api/session/forget' && fake.failForget) { this.onerror(); return; }
        this.status = 200; let response;
        if (this.url === '/api/pair') { fake.remembered = body.remember; response = issue(fake.remembered); }
        else if (this.url === '/api/session') { if (fake.remembered) response = issue(true); else this.status = 401; }
        else if (this.url === '/api/session/forget') { fake.remembered = false; fake.token = ''; response = { ok: true }; }
        else if (this.headers.Authorization !== 'Bearer ' + fake.token) this.status = 401;
        else if (this.url === '/api/session/remember') { fake.remembered = true; response = issue(true); }
        else if (this.url === '/api/state' && fake.rejectState > 0) { fake.rejectState -= 1; this.status = 401; }
        else if (this.url === '/api/state') response = { config, apps: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] };
        else { this.status = 404; }
        this.responseText = JSON.stringify(response || { error: 'Pair again.' }); this.onload();
      });
    }
    abort() { if (this.onabort) this.onabort(); }
  }
  const window = { location: { hash: options.hash || '', pathname: '/', search: '' }, history: { replaceState() { window.location.hash = ''; } }, listeners: {}, confirm: () => true, matchMedia: () => ({ matches: false }), addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  const navigator = { userAgent: options.userAgent || 'Browser', maxTouchPoints: 0 };
  const context = vm.createContext({ window, document, navigator, sessionStorage, XMLHttpRequest: XHR, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'phone.js' });
  return { fake, elements, stored, document, window, click: id => elements.get(id).fire('click'), async flush() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); } };
}

test('fresh startup checks cookie; default manual pairing remembers without persistent JS secret', async () => {
  const h = harness(); await h.flush();
  assert.equal(h.fake.calls[0].url, '/api/session');
  assert.equal(h.elements.get('pair-button').disabled, false);
  h.elements.get('pair-code').value = '123456'; h.elements.get('pair-form').fire('submit'); await h.flush();
  assert.equal(h.fake.calls.find(call => call.url === '/api/pair').body.remember, true);
  assert.equal(h.elements.get('settings-view').hidden, false);
  assert.match(h.elements.get('session-note').textContent, /remembered/);
  assert.equal(JSON.parse(h.stored.get(key)).token, h.fake.token);
  assert.equal(h.elements.get('install-button').hidden, true);
});

test('remembered fresh-page recovery and one 401 retry preserve app/file drafts', async () => {
  const h = harness({ remembered: true }); await h.flush();
  assert.deepEqual(h.fake.calls.map(call => call.url), ['/api/session', '/api/state']);
  const checkbox = h.elements.get('available-apps').querySelectorAll('input')[0]; checkbox.checked = false; checkbox.fire('change');
  h.elements.get('wallpaper-file').files = [{ name: 'kept.mp4', size: 20 }]; h.elements.get('wallpaper-file').fire('change');
  const previous = h.fake.token; h.fake.rejectState = 1; h.click('refresh-button'); await h.flush();
  assert.notEqual(h.fake.token, previous);
  assert.equal(h.fake.calls.filter(call => call.url === '/api/session').length, 2);
  assert.equal(h.fake.calls.filter(call => call.url === '/api/state').length, 3);
  assert.equal(h.elements.get('settings-view').hidden, false);
  assert.equal(h.elements.get('save-apps-button').disabled, false);
  assert.equal(h.elements.get('selected-file-name').textContent, 'kept.mp4');
  assert.equal(h.elements.get('available-apps').querySelectorAll('input')[0].checked, false);
});

test('transient renewal and forget failures retain connection; successful forget clears it', async () => {
  const h = harness({ remembered: true }); await h.flush();
  const token = h.fake.token; h.fake.rejectState = 1; h.fake.failSession = true; h.click('refresh-button'); await h.flush();
  assert.equal(h.fake.token, token); assert.equal(h.elements.get('settings-view').hidden, false); assert(h.stored.has(key));
  assert.match(h.elements.get('notice').textContent, /Could not reach/);
  h.fake.failSession = false; h.fake.failForget = true; h.click('forget-button'); await h.flush();
  assert.equal(h.elements.get('settings-view').hidden, false); assert(h.stored.has(key));
  assert.match(h.elements.get('notice').textContent, /Could not forget/);
  h.fake.failForget = false; h.click('forget-button'); await h.flush();
  assert.equal(h.elements.get('settings-view').hidden, true); assert.equal(h.stored.has(key), false); assert.equal(h.fake.remembered, false);
});

test('revoked stored session is validated and a repeated 401 never loops', async () => {
  const h = harness({ remembered: true, stored: { token: 'previous', expiresAt: Date.now() + 10000, remembered: true } });
  h.fake.rejectState = 2; await h.flush();
  assert.equal(h.fake.calls.filter(call => call.url === '/api/session').length, 1);
  assert.equal(h.fake.calls.filter(call => call.url === '/api/state').length, 2);
  assert.equal(h.elements.get('pair-view').hidden, false); assert.equal(h.stored.has(key), false);
});

test('temporary pairing can opt into remembering; QR always remembers and removes code first', async () => {
  const h = harness(); await h.flush();
  h.elements.get('remember-phone').checked = false; h.elements.get('pair-code').value = '123456'; h.elements.get('pair-form').fire('submit'); await h.flush();
  assert.equal(h.fake.remembered, false); assert.equal(h.elements.get('remember-button').hidden, false);
  h.click('remember-button'); await h.flush();
  assert.equal(h.fake.remembered, true); assert.equal(h.elements.get('install-help').open, true);
  const qr = harness({ hash: '#pair=123456', userAgent: 'iPhone' }); await qr.flush();
  assert.equal(qr.window.location.hash, ''); assert.equal(qr.fake.calls[0].url, '/api/pair'); assert.equal(qr.fake.calls[0].body.remember, true);
  assert.equal(qr.elements.get('install-android').hidden, true);
});

test('expired stored token uses cookie, and revoked cookie rejects automatic reopening', async () => {
  const h = harness({ remembered: true, stored: { token: 'expired', expiresAt: Date.now() - 1 } }); await h.flush();
  assert.equal(h.fake.calls[0].url, '/api/session'); assert.equal(h.elements.get('settings-view').hidden, false);
  h.fake.remembered = false; h.fake.token = 'revoked'; h.click('refresh-button'); await h.flush();
  assert.equal(h.elements.get('settings-view').hidden, true); assert.equal(h.stored.has(key), false);
});
