const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function projection() {
  const elements = new Map(), handlers = {}, intervals = [];
  const element = () => {
    let content = '';
    const classes = new Set();
    return { value: '', checked: true, children: [], focus() {}, setAttribute() {},
      classList: { toggle(name, force) { (force === undefined ? !classes.has(name) : force) ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
      get textContent() { return content; },
      set textContent(value) { content = value; this.children = []; this.value = ''; },
      appendChild(child) { this.children.push(child); if (this.children.length === 1) this.value = child.value; } };
  };
  const opener = { closed: false, postMessage() {} };
  const stored = new Map();
  const context = vm.createContext({
    localStorage: { getItem: key => stored.has(key) ? stored.get(key) : null, setItem(key, value) { stored.set(key, String(value)); }, removeItem(key) { stored.delete(key); } },
    window: { opener, addEventListener(name, fn) { handlers[name] = fn; } },
    location: { origin: 'http://localhost:8080' }, Date,
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: tag => tag === 'option' ? { value: '', textContent: '' } : element(), addEventListener() {} },
    setInterval(fn) { intervals.push(fn); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/connection.js'), 'utf8'), context);
  return { elements, opener, intervals, stored, receive(data, source = opener, origin = 'http://localhost:8080') {
    handlers.message({ data, source, origin });
  } };
}

test('projection shows actual server address/port and class code, clears code on end', () => {
  const p = projection();
  const message = { t: 'classConnection', code: '123456', connected: true,
    connection: { port: 18080, addresses: [{ ip: '192.168.1.28', iface: 'Wi-Fi', virtual: false }] } };
  p.receive(message);
  assert.equal(p.elements.get('address').textContent, '192.168.1.28:18080');
  assert.equal(p.elements.get('classCode').textContent, '123456');
  p.receive({ ...message, code: '' });
  assert.equal(p.elements.get('classCode').textContent, '------');
  assert.match(p.elements.get('status').textContent, /종료/);
});

test('projection rejects foreign senders and clears a closed teacher tab', () => {
  const p = projection();
  p.receive({ t: 'classConnection', code: '999999' }, {}, 'https://foreign.example');
  assert.equal(p.elements.get('classCode').textContent, '');
  p.opener.closed = true;
  p.intervals[0]();
  assert.equal(p.elements.get('classCode').textContent, '------');
  assert.match(p.elements.get('status').textContent, /닫혔/);
});

test('projection shows detected Wi-Fi, masks the key on request, and keeps a manual override', () => {
  const p = projection();
  const message = { t: 'classConnection', code: '123456', connected: true,
    connection: { port: 8080, addresses: [{ ip: '192.168.1.28', iface: 'Wi-Fi', virtual: false }],
      wifi: { ssid: 'School-Student', key: 'abcd1234', supported: true } } };
  p.receive(message);
  assert.equal(p.elements.get('wifiSsid').textContent, 'School-Student');
  assert.equal(p.elements.get('wifiKey').textContent, 'abcd1234');
  assert.match(p.elements.get('wifiSource').textContent, /자동 감지/);
  // 비밀번호 숨기기
  p.elements.get('keyToggle').checked = false;
  p.elements.get('keyToggle').onchange();
  assert.equal(p.elements.get('wifiKey').textContent, '●●●●●●');
  p.elements.get('keyToggle').checked = true;
  p.elements.get('keyToggle').onchange();
  // 교사가 학생용 Wi-Fi를 직접 입력
  p.elements.get('wifiEdit').onclick();
  assert.equal(p.elements.get('wifiSsidInput').value, 'School-Student');
  p.elements.get('wifiSsidInput').value = ' Student-WiFi ';
  p.elements.get('wifiKeyInput').value = 'pw5678';
  p.elements.get('wifiForm').onsubmit({ preventDefault() {} });
  assert.equal(p.elements.get('wifiSsid').textContent, 'Student-WiFi');
  assert.equal(p.elements.get('wifiKey').textContent, 'pw5678');
  assert.match(p.elements.get('wifiSource').textContent, /직접 입력/);
  assert.equal(JSON.parse(p.stored.get('sm_wifi_override')).ssid, 'Student-WiFi');
  // 서버가 새 감지값을 보내도 직접 입력값을 유지한다
  p.receive(message);
  assert.equal(p.elements.get('wifiSsid').textContent, 'Student-WiFi');
  // 자동 감지로 되돌리기
  p.elements.get('wifiAuto').onclick();
  assert.equal(p.elements.get('wifiSsid').textContent, 'School-Student');
  assert.equal(p.stored.has('sm_wifi_override'), false);
});

test('projection without Wi-Fi info asks the teacher to type it', () => {
  const p = projection();
  p.receive({ t: 'classConnection', code: '123456', connected: true,
    connection: { port: 8080, addresses: [], wifi: { ssid: '', key: '', supported: true } } });
  assert.match(p.elements.get('wifiSsid').textContent, /수정/);
  assert.match(p.elements.get('wifiSource').textContent, /자동 감지/);
});
