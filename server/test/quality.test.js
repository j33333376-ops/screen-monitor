const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { createRecorder } = require('../recording');
const { createCaptureRequests } = require('../capture-requests');

async function setup(fetchCapture, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-quality-'));
  const low = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  const st = { id: 1, grade: '1', cls: '1', num: '1', name: 'quality', ws: {}, frames: [],
    highCapture: true, lastThumb: low, lastFrameAt: Date.now() };
  const session = { code: '123456', students: new Map([[1, st]]) };
  const recorder = createRecorder({ dir, intervalMs: 30000, maxBytes: 1024 * 1024,
    notify() {}, fetchCapture, ...options });
  return { dir, st, session, recorder };
}
async function loadPdf(dir) {
  const files = await fs.readdir(dir, { recursive: true });
  const file = files.find(file => file.endsWith('.pdf'));
  return { file, pdf: await PDFDocument.load(await fs.readFile(path.join(dir, file))) };
}

test('one hour of 30-second AI captures survives a small RAM budget with full PDF resolution', async () => {
  const jpeg = await fs.readFile(path.join(__dirname, 'high-capture.jpg'));
  let sequence = 0;
  const { dir, st, session: s, recorder: r } = await setup(async () => {
    const comment = Buffer.from(String(sequence++).padStart(4, '0'));
    return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 6]), comment, jpeg.subarray(2)]);
  }, { maxBytes: jpeg.length * 2 });
  r.start(s, 'ai');
  for (let i = 0; i < 120; i++) {
    s.nextSaveAt = Date.now() - 1;
    r.tick(s);
    await st.capturePromise;
    await Promise.all(s.pendingWrites);
    assert.equal(s.saveOn, true);
  }
  assert.equal(st.frames.length, 120);
  assert.ok(st.frames.every(frame => frame.bytes === null));
  st.ws = null;
  assert.equal(await r.finish(s), true);
  const { file, pdf } = await loadPdf(dir);
  assert.match(file, /_AI고화질\.pdf$/);
  assert.equal(pdf.getPageCount(), 120);
  assert.ok(pdf.getPages().every(page => page.getWidth() === 2560 && page.getHeight() === 1600));
  assert.deepEqual(await fs.readdir(path.join(dir, '.pending')), []);
});

test('finish awaits the final requested AI JPEG instead of using the thumbnail', async () => {
  let deliver;
  const high = await fs.readFile(path.join(__dirname, 'high-capture.jpg'));
  const { dir, st, session: s, recorder: r } = await setup(() => new Promise(resolve => { deliver = resolve; }));
  r.start(s, 'ai');
  const finished = r.finish(s);
  assert.equal(r.info(s).busy, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(st.frames.length, 0);
  deliver(high);
  assert.equal(await finished, true);
  assert.equal((await loadPdf(dir)).pdf.getPage(0).getWidth(), 2560);
});

test('timeouts are reported and legacy apps are explicitly identified', async () => {
  const { st, session: s, recorder: r } = await setup(async () => null);
  r.start(s, 'ai');
  await r.capture(s, st);
  assert.equal(st.frames.length, 0);
  assert.match(r.info(s).warning, /1회 수신 실패/);
  st.highCapture = false;
  assert.match(r.info(s).warning, /구버전 학생 앱 1명/);
  r.capture(s, st);
  assert.equal(st.frames.length, 1);
  assert.equal(await r.finish(s), true);
});

test('disk failure retains the image and PDF retry recovers it', async () => {
  const high = await fs.readFile(path.join(__dirname, 'high-capture.jpg'));
  const blocked = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-retry-')), 'captures');
  await fs.writeFile(blocked, 'test-only blocking file');
  const { st, session: s, recorder: r } = await setup(async () => high, { dir: blocked });
  r.start(s, 'ai');
  await r.capture(s, st);
  await Promise.all(s.pendingWrites);
  assert.equal(s.spoolError, true);
  assert.deepEqual(Buffer.from(st.frames[0].bytes), high);
  assert.equal(await r.finish(s), false);
  assert.equal(r.start(s, 'standard'), false);
  await fs.unlink(blocked);
  assert.equal(await r.finish(s), true);
  assert.equal((await loadPdf(blocked)).pdf.getPageCount(), 1);
});

test('capture replies must match both request ID and connection; timeout/cancel resolves', async () => {
  let sent;
  const requests = createCaptureRequests({ send(ws, msg) { sent = msg; }, timeoutMs: 30 });
  const socket = { readyState: 1, OPEN: 1 };
  const st = { ws: socket };
  const pending = requests.request({}, st);
  assert.equal(requests.request({}, st), pending);
  requests.accept(st, sent.requestId + 1, Buffer.from('wrong'));
  st.ws = { readyState: 1, OPEN: 1 };
  requests.accept(st, sent.requestId, Buffer.from('stale'));
  st.ws = socket;
  requests.accept(st, sent.requestId, Buffer.from('correct'));
  assert.equal((await pending).toString(), 'correct');
  assert.equal(await requests.request({}, st), null);
  const canceled = requests.request({}, st);
  requests.cancel(st);
  assert.equal(await canceled, null);
});
