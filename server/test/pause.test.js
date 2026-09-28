const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { PDFDocument } = require('pdf-lib');
const zlib = require('node:zlib');
const { createRecorder, captureTimeText } = require('../recording');

const pdfsIn = async dir => (await fs.readdir(dir, { recursive: true }).catch(() => [])).filter(f => f.endsWith('.pdf'));
// pdf-lib는 페이지 내용을 압축하고 글자를 16진수로 적는다. 압축을 풀어 찍힌 문자열을 모은다.
function stampedTexts(pdfBytes) {
  const raw = Buffer.from(pdfBytes).toString('latin1');
  const found = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body;
    try { body = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) found.push(Buffer.from(t[1], 'hex').toString('latin1'));
  }
  return found;
}

test('each PDF page carries its own capture time, in order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-stamp-'));
  const a = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  const b = await fs.readFile(path.join(__dirname, 'high-capture.jpg'));
  const t1 = new Date(2026, 8, 28, 9, 5, 7).getTime(), t2 = new Date(2026, 8, 28, 9, 35, 40).getTime();
  assert.equal(captureTimeText(t1), '2026-09-28 09:05:07', '두 자리로 채운 날짜·시각');
  const st = { id: 1, grade: '1', cls: '2', num: '3', name: '시각', ws: {}, frames: [], lastThumb: a, lastFrameAt: t1 };
  const s = { code: '123456', students: new Map([[1, st]]) };
  const r = createRecorder({ dir, intervalMs: 30000, maxBytes: 8 * 1024 * 1024, notify() {} });
  r.start(s);
  r.capture(s, st);
  await r.pause(s);
  st.lastThumb = b; st.lastFrameAt = t2;
  r.start(s);
  r.capture(s, st);
  assert.equal(await r.finish(s), true);
  const [file] = await pdfsIn(dir);
  assert.deepEqual(stampedTexts(await fs.readFile(path.join(dir, file))),
    ['2026-09-28 09:05:07', '2026-09-28 09:35:40'], '일시정지 전후 페이지에 각자의 캡처 시각');
});

test('stopping only pauses: captures before and after the pause end up in one PDF per student at the end', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-pause-'));
  const a = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  const b = await fs.readFile(path.join(__dirname, 'high-capture.jpg'));
  const st = { id: 1, grade: '1', cls: '2', num: '3', name: '일시정지', ws: {}, frames: [], lastThumb: a, lastFrameAt: 1 };
  const s = { code: '123456', students: new Map([[1, st]]) };
  const r = createRecorder({ dir, intervalMs: 30000, maxBytes: 8 * 1024 * 1024, notify() {} });

  assert.equal(r.start(s), true);
  r.capture(s, st);
  st.lastThumb = b;
  assert.equal(await r.pause(s), true, '멈추는 순간의 화면도 남긴다');
  assert.equal(st.frames.length, 2);
  assert.deepEqual([r.info(s).on, r.info(s).paused, r.info(s).captured], [false, true, 2]);
  assert.deepEqual(await pdfsIn(dir), [], '일시정지는 PDF를 만들지 않는다');

  // 일시정지 중에는 주기가 와도 캡처하지 않는다.
  s.nextSaveAt = 0;
  st.lastThumb = a;
  r.tick(s);
  assert.equal(st.frames.length, 2);

  assert.equal(r.start(s), true, '다시 시작하면 같은 기록에 이어서');
  assert.equal(st.frames.length, 2, '이어 시작할 때 모은 캡처를 지우지 않는다');
  r.capture(s, st);
  assert.equal(r.info(s).captured, 3);

  assert.equal(await r.finish(s), true);
  const files = await pdfsIn(dir);
  assert.equal(files.length, 1, '학생 한 명당 PDF 1개');
  const pdf = await PDFDocument.load(await fs.readFile(path.join(dir, files[0])));
  assert.equal(pdf.getPageCount(), 3);
  assert.equal(r.info(s).paused, false);

  // 일시정지한 채로 수업을 끝내도 모은 캡처는 저장된다.
  r.start(s);
  r.capture(s, st);
  await r.pause(s);
  assert.equal(await r.finish(s), true);
  assert.equal((await pdfsIn(dir)).length, 2);
});

test('through the server: stop pauses, restart resumes, lesson end writes one PDF each; quality stays fixed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-pause-server-'));
  const a = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  const b = await fs.readFile(path.join(__dirname, 'high-capture.jpg'));
  const server = fork(path.join(__dirname, '../server.js'), [], { silent: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SAVE_CAPTURES: 'off', SAVE_INTERVAL_SEC: '0.2',
      SAVE_DIR: dir, TEACHER_PASSWORD: 'pause-test' } });
  const peers = [];
  try {
    const [{ port }] = await once(server, 'message');
    async function peer() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      peers.push(ws);
      const messages = [];
      ws.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data)); });
      await once(ws, 'open');
      return { ws, send: msg => ws.send(JSON.stringify(msg)), messages, async wait(type, match = () => true) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const i = messages.findIndex(m => m.t === type && match(m));
          if (i >= 0) return messages.splice(i, 1)[0];
          await new Promise(r => setTimeout(r, 10));
        }
        throw new Error(`No ${type} message`);
      } };
    }
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'pause-test', interval: 0.2 });
    const { code } = await teacher.wait('created');
    const students = [];
    for (const num of ['1', '2']) {
      const st = await peer();
      st.send({ t: 'hello', code, grade: '1', cls: '4', num, name: `학생${num}`, notice: true, highCapture: true });
      await st.wait('ok');
      st.ws.send(Buffer.concat([Buffer.from([1]), a]));
      students.push(st);
    }
    const sendAll = jpeg => students.forEach(st => st.ws.send(Buffer.concat([Buffer.from([1]), jpeg])));

    teacher.send({ t: 'save', on: true });
    await teacher.wait('saveState', m => m.save.on);
    // 저장 중에는 주기도 잠기고 이유를 알려 준다.
    teacher.send({ t: 'saveInterval', interval: 10 });
    assert.match((await teacher.wait('settingLocked')).msg, /일시정지를 누른 뒤/);
    await new Promise(r => setTimeout(r, 400));
    teacher.send({ t: 'save', on: false });
    const paused = await teacher.wait('saveState', m => m.save.paused && !m.save.pausing);
    assert.ok(paused.save.captured >= 2);
    assert.deepEqual(await pdfsIn(dir), [], '저장 중지를 눌러도 PDF가 생기지 않는다');
    assert.equal((await students[0].wait('recording', m => m.on === false)).on, false, '학생 앱에도 기록 멈춤 표시');

    // 일시정지 중에는 화질을 바꿀 수 없고, 이유를 알려 준다. 주기는 바꿀 수 있다.
    teacher.send({ t: 'saveQuality', quality: 'ai' });
    assert.match((await teacher.wait('settingLocked')).msg, /화질을 바꿀 수 없습니다/);
    assert.equal((await teacher.wait('saveState', m => m.save.paused)).save.quality, 'standard');
    teacher.send({ t: 'saveInterval', interval: 10 });
    assert.equal((await teacher.wait('saveState', m => m.save.intervalSec === 10)).save.intervalSec, 10);

    sendAll(b);
    teacher.send({ t: 'save', on: true });
    await teacher.wait('saveState', m => m.save.on);
    await new Promise(r => setTimeout(r, 400));
    teacher.send({ t: 'end' });
    await teacher.wait('ended');

    const files = await pdfsIn(dir);
    assert.equal(files.length, 2, `학생 2명 → PDF 2개 (${files.join(', ')})`);
    for (const file of files) {
      const pdf = await PDFDocument.load(await fs.readFile(path.join(dir, file)));
      assert.ok(pdf.getPageCount() >= 2, '일시정지 전후 캡처가 한 PDF에 들어 있다');
    }
  } finally {
    for (const ws of peers) ws.terminate();
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
  }
});
