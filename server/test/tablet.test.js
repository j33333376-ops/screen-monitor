const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const { WebSocket } = require('ws');

async function classroom(run) {
  const server = fork(path.join(__dirname, '../server.js'), [], { silent: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SAVE_CAPTURES: 'off', TEACHER_PASSWORD: 'tablet-test' } });
  const peers = [];
  try {
    const [{ port }] = await once(server, 'message');
    async function peer() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      peers.push(ws);
      const messages = [];
      ws.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : JSON.parse(data)));
      await once(ws, 'open');
      return { ws, send: msg => ws.send(JSON.stringify(msg)), messages, async wait(type, match = () => true) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const i = messages.findIndex(m => (type === 'frame' ? Buffer.isBuffer(m) : m.t === type) && match(m));
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

test('a tablet joins the running class, controls it, and keeps it alive after the laptop closes', async () => {
  const jpeg = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  await classroom(async (peer) => {
    const laptop = await peer();
    laptop.send({ t: 'create', password: 'tablet-test', lessonTitle: '비례식' });
    const { code } = await laptop.wait('created');
    assert.equal((await laptop.wait('teachers')).count, 1);

    const student = await peer();
    student.send({ t: 'hello', code, grade: '1', cls: '2', num: '3', name: '학생', notice: true, highCapture: true });
    await student.wait('ok');
    student.ws.send(Buffer.concat([Buffer.from([1]), jpeg]));
    await laptop.wait('frame');

    // 수업이 하나뿐이면 코드 없이 비밀번호만으로 합류한다.
    const tablet = await peer();
    tablet.send({ t: 'attach', password: 'tablet-test' });
    const joined = await tablet.wait('resumed');
    assert.equal(joined.code, code);
    assert.equal(joined.lessonTitle, '비례식');
    assert.equal(joined.students.length, 1);
    assert.ok(joined.token, '새로고침 복구용 토큰을 받는다');
    assert.equal((await tablet.wait('frame')).readUInt32BE(1), joined.students[0].id, '마지막 화면을 바로 받는다');
    assert.equal((await laptop.wait('teachers', m => m.count === 2)).count, 2, '노트북에도 교사 화면 2대로 표시');

    // 태블릿에서도 수업을 제어할 수 있다.
    tablet.send({ t: 'message', text: '태블릿에서 보낸 안내' });
    assert.equal((await student.wait('notice')).text, '태블릿에서 보낸 안내');
    tablet.send({ t: 'save', on: true });
    assert.equal((await laptop.wait('saveState', m => m.save.on)).save.on, true, '저장 상태가 노트북에도 반영');

    // 노트북 창을 닫아도 태블릿으로 수업이 이어진다.
    laptop.ws.close();
    assert.equal((await tablet.wait('teachers', m => m.count === 1)).count, 1);
    tablet.messages.length = 0;
    student.ws.send(Buffer.concat([Buffer.from([1]), jpeg]));
    await tablet.wait('frame');
    tablet.send({ t: 'save', on: false });
    tablet.send({ t: 'end' });
    await tablet.wait('ended');
  });
});

test('joining needs the password and picks the class by code when several are running', async () => {
  await classroom(async (peer) => {
    const nobody = await peer();
    nobody.send({ t: 'attach', password: 'tablet-test' });
    assert.match((await nobody.wait('error')).msg, /진행 중인 수업이 없습니다/);

    const first = await peer();
    first.send({ t: 'create', password: 'tablet-test' });
    const a = await first.wait('created');
    const second = await peer();
    second.send({ t: 'create', password: 'tablet-test' });
    const b = await second.wait('created');

    const wrong = await peer();
    wrong.send({ t: 'attach', password: 'nope', code: a.code });
    assert.equal((await wrong.wait('error')).msg, '비밀번호가 틀렸습니다.');
    wrong.send({ t: 'ping' }); await wrong.wait('pong');
    assert.equal(wrong.messages.some(m => m.t === 'resumed'), false);

    const ambiguous = await peer();
    ambiguous.send({ t: 'attach', password: 'tablet-test' });
    assert.match((await ambiguous.wait('error')).msg, /여러 개/);

    const missing = await peer();
    missing.send({ t: 'attach', password: 'tablet-test', code: '000000' });
    assert.match((await missing.wait('error')).msg, /찾지 못했습니다/);

    const tablet = await peer();
    tablet.send({ t: 'attach', password: 'tablet-test', code: b.code });
    assert.equal((await tablet.wait('resumed')).code, b.code);
    assert.equal((await second.wait('teachers', m => m.count === 2)).count, 2);
    assert.equal(first.messages.some(m => m.t === 'teachers' && m.count === 2), false, '다른 수업에는 합류하지 않는다');
  });
});

test('the laptop QR opens the class on a tablet once, and a used, cancelled or expired key is refused', async () => {
  await classroom(async (peer) => {
    const laptop = await peer();
    laptop.send({ t: 'create', password: 'tablet-test' });
    const { code } = await laptop.wait('created');

    laptop.send({ t: 'pairStart' });
    const qr = await laptop.wait('pairQr');
    assert.match(qr.svg, /^<svg/);
    assert.equal(qr.ttlSec, 120);
    const [, qrCode, key] = /#pair=(\d{6})\.([a-f0-9]{36})$/.exec(qr.url);
    assert.equal(qrCode, code);

    const tablet = await peer();
    tablet.send({ t: 'pair', code, token: key });
    assert.equal((await tablet.wait('resumed')).code, code, '비밀번호 없이 QR 열쇠로 합류');
    await laptop.wait('paired');
    assert.equal((await laptop.wait('teachers', m => m.count === 2)).count, 2);

    // 같은 QR을 다른 기기(예: 프로젝터 화면을 찍은 학생)가 다시 써도 들어올 수 없다.
    const reuse = await peer();
    reuse.send({ t: 'pair', code, token: key });
    assert.match((await reuse.wait('error')).msg, /만료되었거나 이미 사용/);

    // 새 QR을 만들면 옛 QR은 무효, 창을 닫으면(pairCancel) 새 QR도 무효.
    laptop.send({ t: 'pairStart' });
    const first = /\.([a-f0-9]{36})$/.exec((await laptop.wait('pairQr')).url)[1];
    laptop.send({ t: 'pairStart' });
    const second = /\.([a-f0-9]{36})$/.exec((await laptop.wait('pairQr')).url)[1];
    const stale = await peer();
    stale.send({ t: 'pair', code, token: first });
    assert.match((await stale.wait('error')).msg, /만료/);
    laptop.send({ t: 'pairCancel' });
    laptop.send({ t: 'ping' }); await laptop.wait('pong');
    const cancelled = await peer();
    cancelled.send({ t: 'pair', code, token: second });
    assert.match((await cancelled.wait('error')).msg, /만료/);

    // 학생은 교사 전용 요청으로 QR을 만들 수 없다.
    const student = await peer();
    student.send({ t: 'hello', code, grade: '1', cls: '1', num: '1', name: '학생', notice: true });
    await student.wait('ok');
    student.send({ t: 'pairStart' });
    student.send({ t: 'ping' }); await student.wait('pong');
    assert.equal(student.messages.some(m => m.t === 'pairQr'), false);
  });
});

test('repeated wrong passwords lock the device even across new connections', async () => {
  await classroom(async (peer) => {
    const laptop = await peer();
    laptop.send({ t: 'create', password: 'tablet-test' });
    await laptop.wait('created');
    // 한 연결에서 5번 틀리면 끊기므로 연결을 바꿔 가며 시도한다.
    for (let i = 0; i < 10; i++) {
      const guess = await peer();
      guess.send({ t: 'attach', password: `guess-${i}` });
      assert.equal((await guess.wait('error')).msg, '비밀번호가 틀렸습니다.');
    }
    const locked = await peer();
    locked.send({ t: 'attach', password: 'tablet-test' });
    assert.match((await locked.wait('error')).msg, /잠겼습니다/, '맞는 비밀번호도 잠시 거절');
    locked.send({ t: 'create', password: 'tablet-test' });
    assert.match((await locked.wait('error')).msg, /잠겼습니다/, '새 수업 만들기도 같이 잠긴다');
  });
});
