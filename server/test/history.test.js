const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { createHistory } = require('../history');
const { createRecorder } = require('../recording');

test('history evicts oldest captures globally and per student, and releases removed students', () => {
  const events = [];
  const history = createHistory({ maxBytes: 6, maxFrames: 2, notify: (s, id) => events.push([s, id]) });
  const s1 = {}, s2 = {}, a = { id: 1 }, b = { id: 2 };
  history.add(s1, a, new Uint8Array(2), 10);
  history.add(s1, a, new Uint8Array(2), 20);
  history.add(s2, b, new Uint8Array(2), 30);
  history.add(s2, b, new Uint8Array(2), 40);
  assert.deepEqual(a.history.map(f => f.at), [20]);
  history.add(s2, b, new Uint8Array(2), 50);
  assert.deepEqual(b.history.map(f => f.at), [40, 50]);
  assert.ok(events.some(([s, id]) => s === s1 && id === 1));
  history.clearStudent(b);
  assert.equal(b.history.length, 0);
  history.add(s1, a, new Uint8Array(2), 60);
  assert.deepEqual(a.history.map(f => f.at), [20, 60]);
});

test('recording captures remain viewable after PDF saving and across recording segments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'screen-monitor-history-test-'));
  const jpeg = await readFile(path.join(__dirname, 'capture.jpg'));
  const history = createHistory({ maxBytes: 1024 * 1024, notify() {} });
  const recorder = createRecorder({ dir, intervalMs: 1000, maxBytes: 1024 * 1024,
    notify() {}, onCapture: history.add });
  const st = { id: 1, grade: '1', cls: '1', num: '1', name: 'test', ws: {},
    frames: [], lastThumb: jpeg, lastFrameAt: 1234 };
  const s = { code: '123456', students: new Map([[1, st]]) };
  recorder.start(s);
  recorder.capture(s, st);
  recorder.capture(s, st);
  assert.equal(st.history.length, 1, 'identical JPEGs are not duplicated');
  assert.equal(st.history[0].at, 1234);
  assert.equal(await recorder.finish(s), true);
  assert.equal(st.frames.length, 0);
  assert.deepEqual(Buffer.from(st.history[0].bytes), jpeg);
  const files = await readdir(dir, { recursive: true });
  const pdfFile = files.find(file => file.endsWith('.pdf'));
  assert.equal((await PDFDocument.load(await readFile(path.join(dir, pdfFile)))).getPageCount(), 1);
  recorder.start(s);
  st.lastFrameAt = 5678;
  recorder.capture(s, st);
  assert.deepEqual(st.history.map(f => f.at), [1234, 5678]);
  await recorder.finish(s);
});
