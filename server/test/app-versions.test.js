const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createAppVersions, compareVersions } = require('../app-versions');

test('version numbers compare by each part, not as text', () => {
  assert.ok(compareVersions('1.4.0', '1.5.0') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0, '10 > 9');
  assert.equal(compareVersions('1.5', '1.5.0'), 0);
});

test('outdated apps are found per platform; no version file means no update prompts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-versions-'));
  const files = { windows: path.join(dir, 'windows.json'), android: path.join(dir, 'android.json') };
  const versions = createAppVersions(files);
  assert.equal(versions.check({ version: '1.0.0' }).outdated, false, '버전 파일이 없으면 판단하지 않는다');

  await fs.writeFile(files.windows, JSON.stringify({ version: '1.5.0' }));
  await fs.writeFile(files.android, JSON.stringify({ version: '1.5.0', build: 6 }));
  assert.deepEqual(versions.check({}).update, { version: '1.5.0', url: '/download/windows' }, '버전을 안 보내는 옛 Windows 앱');
  assert.equal(versions.check({ platform: 'windows', version: '1.5.0' }).outdated, false);
  assert.equal(versions.check({ platform: 'windows', version: '1.4.9' }).outdated, true);
  assert.equal(versions.check({ platform: 'android' }).update.url, '/download/android', '옛 Android 1.4.0');
  assert.equal(versions.check({ platform: 'android', version: '1.5.0', build: 5 }).outdated, true, 'Android는 빌드 번호로 비교');
  assert.equal(versions.check({ platform: 'android', version: '1.5.0', build: 6 }).outdated, false);
  assert.equal(versions.check({ platform: 'windows', version: '../../etc' }).version, null, '이상한 버전 문자열은 버린다');

  // 교사 서버 파일을 새 버전으로 바꾸면 서버를 다시 켜지 않아도 반영된다.
  await new Promise(r => setTimeout(r, 20));
  await fs.writeFile(files.windows, JSON.stringify({ version: '1.6.0' }));
  assert.equal(versions.check({ platform: 'windows', version: '1.5.0' }).latestVersion, '1.6.0');
});

test('through the server: an old app gets an update link and the teacher tile is marked', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-versions-server-'));
  await fs.writeFile(path.join(dir, 'windows.json'), JSON.stringify({ version: '1.5.0' }));
  await fs.writeFile(path.join(dir, 'android.json'), JSON.stringify({ version: '1.5.0', build: 6 }));
  const server = fork(path.join(__dirname, '../server.js'), [], { silent: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SAVE_CAPTURES: 'off', APP_VERSION_DIR: dir, TEACHER_PASSWORD: 'version-test' } });
  const peers = [];
  try {
    const [{ port }] = await once(server, 'message');
    async function peer() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      peers.push(ws);
      const messages = [];
      ws.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data)); });
      await once(ws, 'open');
      return { send: msg => ws.send(JSON.stringify(msg)), async wait(type, match = () => true) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const i = messages.findIndex(m => m.t === type && match(m));
          if (i >= 0) return messages.splice(i, 1)[0];
          await new Promise(r => setTimeout(r, 10));
        }
        throw new Error(`No ${type} message`);
      } };
    }
    const teacher = await peer();
    teacher.send({ t: 'create', password: 'version-test' });
    const { code } = await teacher.wait('created');
    const base = { t: 'hello', code, grade: '1', cls: '1', name: '학생', notice: true, highCapture: true };

    const old = await peer();
    old.send({ ...base, num: '1', platform: 'windows', version: '1.4.0' });
    assert.deepEqual((await old.wait('ok')).update, { version: '1.5.0', url: '/download/windows' });
    const tile = (await teacher.wait('join', m => m.student.num === '1')).student;
    assert.deepEqual([tile.outdated, tile.appVersion, tile.latestVersion, tile.platform], [true, '1.4.0', '1.5.0', 'windows']);

    const current = await peer();
    current.send({ ...base, num: '2', platform: 'android', version: '1.5.0', build: 6 });
    assert.equal((await current.wait('ok')).update, null);
    assert.equal((await teacher.wait('join', m => m.student.num === '2')).student.outdated, false);
  } finally {
    for (const ws of peers) ws.terminate();
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
  }
});
