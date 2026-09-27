const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function browser() {
  let now = 100000;
  const sockets = [], elements = new Map();
  class Socket {
    static OPEN = 1; static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  const element = () => ({ value: '', textContent: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, remove() {},
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, close() {}, showModal() {}, focus() {} });
  const context = vm.createContext({
    WebSocket: Socket, Date: { now: () => now },
    location: { protocol: 'http:', host: 'localhost' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, addEventListener() {}, documentElement: { style: { setProperty() {} } } },
    window: { addEventListener() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext("code = '123456'; token = 'session-token'; connect(s => s.send(JSON.stringify({t:'resume', code, token})));", context);
  sockets[0].open();
  sockets[0].receive({ t: 'resumed', code: '123456', token: 'session-token', students: [], save: { on: false } });
  return { context, sockets, advance(ms) { now += ms; }, check() { vm.runInContext('checkConnectionAfterWake()', context); } };
}

test('teacher resumes after 11-minute sleep even if TCP socket still looks open', () => {
  const b = browser();
  b.advance(11 * 60000); b.check();
  assert.equal(b.sockets.length, 2);
  b.sockets[1].open();
  assert.deepEqual(b.sockets[1].sent[0], { t: 'resume', code: '123456', token: 'session-token' });
  // A late response from the old connection must not erase the restored class.
  b.sockets[0].receive({ t: 'ended' });
  assert.equal(vm.runInContext('code', b.context), '123456');
});

test('heartbeat detects a dead connection without any close event; healthy class stays connected', () => {
  const b = browser();
  for (let i = 0; i < 5; i++) {
    b.advance(5000); b.check(); b.sockets[0].receive({ t: 'pong' });
  }
  assert.equal(b.sockets.length, 1);
  for (let i = 0; i < 4; i++) { b.advance(5000); b.check(); }
  assert.equal(b.sockets.length, 2);
});

test('explicitly ended class is never restored by wake detection', () => {
  const b = browser();
  vm.runInContext("resetSession('수업 종료')", b.context);
  b.advance(11 * 60000); b.check();
  assert.equal(b.sockets.length, 1);
});

test('title drafts survive reconnect and are included in save/end even without Apply', () => {
  const b = browser();
  vm.runInContext("$('lessonTitle').value = '분수의 나눗셈'; $('lessonTitle').oninput();", b.context);
  b.sockets[0].receive({ t: 'resumed', code: '123456', token: 'session-token',
    lessonTitle: '이전 수업명', students: [], save: { on: true } });
  assert.equal(vm.runInContext("$('lessonTitle').value", b.context), '분수의 나눗셈');
  vm.runInContext("$('saveBtn').onclick()", b.context);
  assert.equal(b.sockets[0].sent.at(-1).lessonTitle, '분수의 나눗셈');
  b.sockets[0].receive({ t: 'lessonTitle', lessonTitle: '분수의 나눗셈' });
  assert.equal(vm.runInContext('lessonTitleDirty', b.context), false);
  b.sockets[0].receive({ t: 'saveState', save: { on: false } });
  vm.runInContext("$('lessonTitle').value = '종료 직전 수정'; $('lessonTitle').oninput(); $('confirmEnd').onclick();", b.context);
  assert.equal(b.sockets[0].sent.at(-1).t, 'end');
  assert.equal(b.sockets[0].sent.at(-1).lessonTitle, '종료 직전 수정');
});
