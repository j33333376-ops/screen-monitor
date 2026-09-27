const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { WebSocket } = require('ws');
const { createRecorder } = require('../recording');

test('sleep recovery replaces only the same run, preserves focus and rejects duplicates', { timeout: 15000 }, async () => {
  const server = fork(path.join(__dirname, '../server.js'), [], { silent: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SAVE_CAPTURES: 'off', TEACHER_PASSWORD: 'recovery-test' } });
  const peers = [];
  try {
    const [{ port }] = await once(server, 'message');
    async function peer() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      peers.push(ws);
      const messages = [];
      ws.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : JSON.parse(data)));
      await once(ws, 'open');
      return { ws, send: msg => ws.send(JSON.stringify(msg)), async wait(type) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const i = messages.findIndex(m => type === 'binary' ? Buffer.isBuffer(m) : m.t === type);
          if (i >= 0) return messages.splice(i, 1)[0];
          await new Promise(r => setTimeout(r, 10));
        }
        throw new Error(`No ${type} message`);
      } };
    }
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'recovery-test' });
    const { code, token } = await teacher.wait('created');
    const hello = { t: 'hello', code, grade: '1', cls: '2', num: '3', name: 'recovery',
      resumeKey: '0123456789abcdef0123456789abcdef', highCapture: true };
    const first = await peer(); first.send(hello);
    const { id } = await first.wait('ok'); await teacher.wait('join');
    teacher.send({ t: 'focus', id }); assert.equal((await first.wait('mode')).full, true);
    first.send({ t: 'pause', paused: true });
    assert.equal((await teacher.wait('join')).student.paused, true);
    const other = await peer(); other.send({ ...hello, resumeKey: 'f'.repeat(32) });
    assert.equal((await other.wait('error')).fatal, true);
    const resumed = await peer(); resumed.send({ ...hello, paused: false });
    assert.equal((await resumed.wait('ok')).id, id);
    assert.equal((await resumed.wait('mode')).full, true);
    assert.equal((await teacher.wait('join')).student.paused, false);
    const jpeg = fs.readFileSync(path.join(__dirname, 'capture.jpg'));
    resumed.ws.send(Buffer.concat([Buffer.from([2]), jpeg]));
    assert.deepEqual((await teacher.wait('binary')).subarray(5), jpeg);
    await new Promise(r => setTimeout(r, 50));
    teacher.send({ t: 'ping' }); await teacher.wait('pong');
    const recoveredTeacher = await peer(); recoveredTeacher.send({ t: 'resume', code, token });
    const snapshot = await recoveredTeacher.wait('resumed');
    assert.equal(snapshot.students.length, 1);
    assert.equal(snapshot.students[0].online, true, 'old socket close must not mark replacement offline');
    assert.equal(snapshot.students[0].id, id);
    resumed.ws.close(); await teacher.wait('leave');
    const reconnected = await peer(); reconnected.send(hello);
    assert.equal((await reconnected.wait('ok')).id, id);
    teacher.send({ t: 'end' }); await reconnected.wait('end');
    const afterEnd = await peer(); afterEnd.send(hello);
    assert.equal((await afterEnd.wait('error')).fatal, true);
  } finally {
    for (const ws of peers) ws.terminate();
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
  }
});

test('paused students do not create cached PDF pages or high-resolution requests', async () => {
  let requested = 0;
  const recorder = createRecorder({ dir: '', intervalMs: 30000, maxBytes: 1000000,
    notify() {}, fetchCapture: async () => { requested++; return null; } });
  const st = { id: 1, ws: {}, paused: true, highCapture: true, frames: [], lastThumb: Buffer.from('old') };
  const session = { code: '123456', students: new Map([[1, st]]) };
  recorder.start(session, 'standard');
  recorder.capture(session, st);
  assert.equal(st.frames.length, 0);
  session.saveQuality = 'ai';
  await recorder.capture(session, st);
  assert.equal(requested, 0);
  st.paused = false;
  await recorder.capture(session, st);
  assert.equal(requested, 1);
});
