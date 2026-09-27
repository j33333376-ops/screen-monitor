const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { WebSocket } = require('ws');
const { createRecorder } = require('../recording');

async function classroom(run) {
  const server = fork(path.join(__dirname, '../server.js'), [], { silent: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SAVE_CAPTURES: 'off', TEACHER_PASSWORD: 'talk-test' } });
  const peers = [];
  try {
    const [{ port }] = await once(server, 'message');
    async function peer() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      peers.push(ws);
      const messages = [];
      ws.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : JSON.parse(data)));
      await once(ws, 'open');
      return { ws, send: msg => ws.send(JSON.stringify(msg)), messages, async wait(type) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const i = messages.findIndex(m => m.t === type);
          if (i >= 0) return messages.splice(i, 1)[0];
          await new Promise(r => setTimeout(r, 10));
        }
        throw new Error(`No ${type} message`);
      } };
    }
    await run(peer);
  } finally {
    for (const ws of peers) ws.terminate();
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
  }
}

test('a class keeps its own capture interval and only accepts the offered choices', async () => {
  await classroom(async (peer) => {
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'talk-test', interval: 10 });
    const created = await teacher.wait('created');
    assert.ok(created.connection.port > 0);
    assert.ok(Array.isArray(created.connection.addresses));
    teacher.send({ t: 'connectionInfo' });
    assert.deepEqual((await teacher.wait('connectionInfo')).connection, created.connection);
    assert.equal(created.save.intervalSec, 10);
    assert.deepEqual(created.save.intervalChoices, [10, 20, 30]);

    teacher.send({ t: 'saveInterval', interval: 20 });
    assert.equal((await teacher.wait('saveState')).save.intervalSec, 20);

    // 선택지에 없는 값은 무시하고 직전 주기를 유지한다.
    teacher.send({ t: 'saveInterval', interval: 15 });
    teacher.send({ t: 'ping' }); await teacher.wait('pong');
    teacher.send({ t: 'saveInterval', interval: 30 });
    assert.equal((await teacher.wait('saveState')).save.intervalSec, 30);

    // 저장 중에는 주기를 바꾸지 않는다.
    teacher.send({ t: 'save', on: true });
    assert.equal((await teacher.wait('saveState')).save.on, true);
    teacher.send({ t: 'saveInterval', interval: 10 });
    const locked = await teacher.wait('saveState');
    assert.equal(locked.save.intervalSec, 30);

    const another = await peer();
    another.send({ t: 'create', password: 'talk-test' });
    assert.equal((await another.wait('created')).save.intervalSec, 30, '기본값은 30초');
  });
});

test('lesson titles persist on resume, stay scoped to a class, and end/save accept unsubmitted edits', async () => {
  await classroom(async peer => {
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'talk-test', lessonTitle: '  분수의  나눗셈  ' });
    const created = await teacher.wait('created');
    assert.equal(created.lessonTitle, '분수의 나눗셈');
    const second = await peer();
    second.send({ t: 'create', password: 'talk-test' });
    assert.equal((await second.wait('created')).lessonTitle, '');

    teacher.send({ t: 'save', on: true, lessonTitle: '비례식' });
    assert.equal((await teacher.wait('lessonTitle')).lessonTitle, '비례식');
    await teacher.wait('saveState');
    teacher.send({ t: 'lessonTitle', lessonTitle: '비례식 실험' });
    assert.equal((await teacher.wait('lessonTitle')).lessonTitle, '비례식 실험');
    const resumed = await peer();
    resumed.send({ t: 'resume', code: created.code, token: created.token });
    assert.equal((await resumed.wait('resumed')).lessonTitle, '비례식 실험');
    teacher.send({ t: 'end', lessonTitle: '종료 직전 수정' });
    assert.equal((await teacher.wait('lessonTitle')).lessonTitle, '종료 직전 수정');
    await teacher.wait('ended');
    assert.equal(second.messages.some(m => m.t === 'lessonTitle'), false);
  });
});

test('recorder samples on the interval the class chose, not the server default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-interval-'));
  const jpeg = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  const st = { id: 1, grade: '1', cls: '1', num: '1', name: 'interval', ws: {}, frames: [],
    lastThumb: jpeg, lastFrameAt: Date.now() };
  const s = { code: '123456', students: new Map([[1, st]]), saveIntervalMs: 10000 };
  const recorder = createRecorder({ dir, intervalMs: 30000, intervalChoices: [10, 20, 30],
    maxBytes: 1024 * 1024, notify() {} });
  recorder.start(s);
  assert.equal(recorder.info(s).intervalSec, 10);
  assert.ok(s.nextSaveAt - Date.now() <= 10000, '첫 수집도 선택한 주기를 따른다');
  s.nextSaveAt = 0;
  recorder.tick(s);
  assert.ok(s.nextSaveAt - Date.now() > 9000, '다음 수집 예약도 10초 뒤');
  await fs.rm(dir, { recursive: true, force: true });
});

test('teacher messages reach updated apps and old apps are reported, never silently dropped', async () => {
  await classroom(async (peer) => {
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'talk-test' });
    const { code } = await teacher.wait('created');

    const updated = await peer();
    updated.send({ t: 'hello', code, grade: '1', cls: '2', num: '3', name: '새앱', notice: true, highCapture: true });
    const { id } = await updated.wait('ok'); await teacher.wait('join');
    const legacy = await peer();
    legacy.send({ t: 'hello', code, grade: '1', cls: '2', num: '4', name: '구버전', highCapture: true });
    await legacy.wait('ok'); await teacher.wait('join');

    teacher.send({ t: 'message', text: '  화면을 보고 손을 들어 주세요  ' });
    const all = await teacher.wait('messageSent');
    assert.deepEqual([all.delivered, all.legacy, all.offline], [1, 1, 0]);
    assert.equal((await updated.wait('notice')).text, '화면을 보고 손을 들어 주세요');

    teacher.send({ t: 'message', id, text: '3번 문제까지 풀어 주세요' });
    const one = await teacher.wait('messageSent');
    assert.deepEqual([one.all, one.delivered, one.legacy], [false, 1, 0]);
    assert.equal((await updated.wait('notice')).text, '3번 문제까지 풀어 주세요');

    // 주소는 길어도 잘리지 않아야 링크가 살아 있다.
    const link = 'https://example.org/class/' + 'a'.repeat(200);
    teacher.send({ t: 'message', text: link });
    assert.equal((await updated.wait('notice')).text, link);

    // 빈 메시지는 학생 화면을 방해하지 않는다.
    teacher.send({ t: 'message', text: '   ' });
    teacher.send({ t: 'ping' }); await teacher.wait('pong');
    assert.equal(legacy.messages.some(m => m.t === 'notice'), false, '구버전 앱에는 보내지 않는다');
  });
});

test('a raised hand survives reconnection and the teacher can lower it', async () => {
  await classroom(async (peer) => {
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'talk-test' });
    const { code, token } = await teacher.wait('created');
    const hello = { t: 'hello', code, grade: '2', cls: '5', num: '7', name: '손', notice: true,
      highCapture: true, resumeKey: 'a'.repeat(32) };

    const student = await peer();
    student.send(hello);
    const { id } = await student.wait('ok'); await teacher.wait('join');

    student.send({ t: 'help', on: true });
    const raised = await teacher.wait('join');
    assert.equal(raised.student.help, true);
    assert.ok(raised.student.helpAt > 0);

    // 절전·재접속으로 소켓이 바뀌어도 손은 내려가지 않는다.
    const again = await peer();
    again.send({ ...hello, help: true });
    assert.equal((await again.wait('ok')).id, id);
    assert.equal((await teacher.wait('join')).student.help, true, '재접속 알림에도 손이 들려 있다');
    const teacherView = await peer();
    teacherView.send({ t: 'resume', code, token });
    assert.equal((await teacherView.wait('resumed')).students[0].help, true);

    teacher.send({ t: 'clearHelp', id });
    assert.equal((await again.wait('help')).on, false);
    assert.equal((await teacher.wait('join')).student.help, false);
  });
});
