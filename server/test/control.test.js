const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

// 교사용 실행기처럼 창 없이 띄우고 표준 입력으로만 조종한다.
function startControlled(saveDir) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, CONTROL_STDIN: '1', PORT: '0', HOST: '127.0.0.1', TEACHER_PASSWORD: 'control-pass',
      SAVE_DIR: saveDir, SAVE_INTERVAL_SEC: '0.2' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  let buffer = '';
  const waiters = [];
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line.startsWith('@@')) continue;
      const event = JSON.parse(line.slice(2));
      events.push(event);
      for (const w of [...waiters]) if (w.match(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
    }
  });
  const waitFor = match => {
    const found = events.find(match);
    return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ match, resolve }));
  };
  return { child, events, waitFor };
}

const message = (ws, match) => new Promise(resolve => ws.on('message', (data, binary) => {
  if (binary) return;
  const m = JSON.parse(data.toString());
  if (match(m)) resolve(m);
}));

test('a shutdown line ends every lesson, saves PDFs, and exits cleanly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-control-'));
  const { child, events, waitFor } = startControlled(dir);
  const { port } = await waitFor(e => e.t === 'ready');
  const url = `ws://127.0.0.1:${port}/ws`;

  const teacher = new WebSocket(url);
  await once(teacher, 'open');
  const created = message(teacher, m => m.t === 'created');
  teacher.send(JSON.stringify({ t: 'create', password: 'control-pass' }));
  const { code } = await created;
  await waitFor(e => e.t === 'lessons' && e.count === 1);

  const student = new WebSocket(url);
  await once(student, 'open');
  const ok = message(student, m => m.t === 'ok');
  student.send(JSON.stringify({ t: 'hello', code, grade: '1', cls: '2', num: '3', name: '제어' }));
  await ok;
  const jpeg = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  student.send(Buffer.concat([Buffer.from([1]), jpeg]));
  await new Promise(r => setTimeout(r, 600));

  const exited = once(child, 'exit');
  child.stdin.write('shutdown\n');
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.ok(events.some(e => e.t === 'shuttingDown' && e.lessons === 1), '종료 시작을 알린다');
  assert.ok(events.some(e => e.t === 'lessons' && e.count === 0), '수업이 모두 끝났다고 알린다');
  const pdfs = (await fs.readdir(dir, { recursive: true })).filter(f => f.endsWith('.pdf'));
  assert.equal(pdfs.length, 1, '학생 PDF 1개를 저장하고 끈다');
});

test('if the launcher disappears (stdin closes), the server still saves and exits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-control-'));
  const { child, waitFor } = startControlled(dir);
  await waitFor(e => e.t === 'ready');
  const exited = once(child, 'exit');
  child.stdin.end();
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
});

test('a busy port is reported as an error event', async () => {
  const net = require('node:net');
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-control-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, CONTROL_STDIN: '1', PORT: String(blocker.address().port), HOST: '127.0.0.1', SAVE_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  const [exitCode] = await once(child, 'exit');
  blocker.close();
  assert.notEqual(exitCode, 0);
  assert.match(out, /@@\{"t":"error","code":"EADDRINUSE"\}/);
});
