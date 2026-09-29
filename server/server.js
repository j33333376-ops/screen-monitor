// 학생 화면 모니터링 중계 서버 (시제품)
// 화면 중계 및 교사가 선택한 구간의 PDF 저장.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createRecorder } = require('./recording');
const { createHistory } = require('./history');
const { createCaptureRequests } = require('./capture-requests');
const { normalizeLessonTitle } = require('./lesson-title');
const { readWifi } = require('./wifi-info');
const QRCode = require('qrcode');
const { createAppVersions } = require('./app-versions');

// 지금 바꿀 수 없는 설정이면 교사에게 보여 줄 이유를, 바꿀 수 있으면 ''를 돌려준다.
// 교사 화면(app.js lockReason)도 같은 규칙으로 먼저 막고, 이 판정은 다른 교사 화면과 동시에 누른 경우를 위한 것이다.
function settingLockReason(session, kind) {
  if (session.ending) return '수업을 종료하는 중이라 바꿀 수 없습니다.';
  if (session.savePromise) return 'PDF를 저장하는 중이라 바꿀 수 없습니다. 저장이 끝난 뒤 다시 시도하세요.';
  if (kind !== 'title' && session.saveStopping) return '일시정지를 처리하는 중입니다. 잠시 뒤 다시 시도하세요.';
  if (session.saveBatch) return 'PDF 저장에 실패한 기록이 있어 바꿀 수 없습니다. 먼저 저장 버튼의 PDF 저장 재시도를 누르세요.';
  if (kind === 'quality' && session.recordingOpen) return '저장을 시작한 수업은 화질을 바꿀 수 없습니다. 한 PDF에 한 가지 화질로만 저장되기 때문입니다. 수업을 종료한 뒤 새 수업을 시작할 때 고르세요.';
  if (kind === 'interval' && session.saveOn) return '저장 중에는 캡처 주기를 바꿀 수 없습니다. ⏸ 저장 일시정지를 누른 뒤 바꾸고, 다시 시작하세요.';
  return '';
}

function updateLessonTitle(session, value) {
  if (session.savePromise || session.saveBatch || session.ending) return false;
  session.lessonTitle = normalizeLessonTitle(value);
  toTeachers(session, JSON.stringify({ t: 'lessonTitle', lessonTitle: session.lessonTitle }), false);
  return true;
}

// 학생에게 알려줄 이 PC의 LAN 주소(들)를 찾는다.
// 가상 어댑터(WSL/Hyper-V/VMware 등)는 뒤로 보내고, 실제 Wi-Fi/이더넷을 앞으로 올린다.
function lanAddresses() {
  const VIRTUAL = /(vethernet|wsl|hyper-v|virtual|vmware|vbox|loopback|docker|tailscale|zerotech|npcap|bluetooth|로컬 영역 연결\*)/i;
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        // 가상 어댑터 이름, 윈도우 핫스팟/ICS 대역(192.168.137.x), 게이트웨이형(.1)은 뒤로.
        const virtual = VIRTUAL.test(iface) ||
          ni.address.startsWith('192.168.137.') || ni.address.endsWith('.1');
        out.push({ ip: ni.address, iface, virtual });
      }
    }
  }
  out.sort((a, b) => (a.virtual === b.virtual ? 0 : a.virtual ? 1 : -1));
  return out;
}

function positiveNumber(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: ${min}~${max} 사이의 숫자를 입력하세요.`);
  return value;
}
const PORT = positiveNumber('PORT', 8080, 0, 65535);
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'teacher1234';
const CONTROL_STDIN = process.env.CONTROL_STDIN === '1';
const TEACHERLESS_TIMEOUT_MS = 30 * 60 * 1000; // 교사가 모두 나간 뒤 30분 지나면 세션 자동 종료
const MAX_TEACHER_BUFFER = 8 * 1024 * 1024;     // 교사 쪽 전송이 밀리면 프레임을 버린다

// ---- 화면 저장(자동) 설정 ----
// SAVE_CAPTURES 는 "수업 시작 시 저장의 기본 상태(on/off)"이며, 교사가 화면에서 언제든 켜고 끌 수 있다.
const SAVE_DEFAULT_ON = (process.env.SAVE_CAPTURES || 'on').toLowerCase() !== 'off';
const SAVE_DIR = process.env.SAVE_DIR ||
  path.join(__dirname, '..', 'captures');
const SAVE_INTERVAL_MS = positiveNumber('SAVE_INTERVAL_SEC', 30, 0.1, 86400) * 1000;
// 교사가 수업마다 고르는 캡처 주기. 시작 파일의 SAVE_INTERVAL_SEC 값도 항상 선택지에 남긴다.
const SAVE_INTERVAL_CHOICES = [...new Set([10, 20, 30, SAVE_INTERVAL_MS / 1000])].sort((a, b) => a - b);
const intervalMs = (value) => SAVE_INTERVAL_CHOICES.includes(Number(value)) ? Number(value) * 1000 : SAVE_INTERVAL_MS;
const history = createHistory({
  maxBytes: 128 * 1024 * 1024,
  notify: (session, id) => {
    for (const teacher of session.teachers) {
      if (teacher.focusId === id) send(teacher, { t: 'historyChanged', id });
    }
  },
});
const captureRequests = createCaptureRequests({ send });
const recorder = createRecorder({
  dir: SAVE_DIR, intervalMs: SAVE_INTERVAL_MS, intervalChoices: SAVE_INTERVAL_CHOICES,
  // 일시정지 기능으로 한 수업의 캡처를 수업 종료까지 모으므로 기본 한도를 넉넉히 둔다(35명·10초·50분 ≈ 230MB).
  maxBytes: positiveNumber('MAX_SAVE_MB', 512, 1, 2048) * 1024 * 1024,
  notify: broadcastSave,
  onCapture: history.add,
  fetchCapture: captureRequests.request,
});
function broadcastSave(session) {
  toTeachers(session, JSON.stringify({ t: 'saveState', save: recorder.info(session) }), false);
  for (const st of session.students.values()) send(st.ws, { t: 'recording', on: session.saveOn,
    captureQuality: session.saveQuality || 'standard' });
}

const KIND_THUMB = 1;
const KIND_FULL = 2;

// ---------- 정적 파일 (교사 화면) ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/connection': ['connection.html', 'text/html; charset=utf-8'],
  '/connection.js': ['connection.js', 'text/javascript; charset=utf-8'],
  '/student': ['student.html', 'text/html; charset=utf-8'],
  '/student/': ['student.html', 'text/html; charset=utf-8'],
};

// Fixed app artifacts only; no user-controlled filesystem paths are accepted.
const DOWNLOADS = {
  '/download/android': { file: path.join(__dirname, '..', 'android', 'dist', '학생화면전송.apk'),
    type: 'application/vnd.android.package-archive', name: '학생화면전송.apk' },
  '/download/windows': { file: path.join(__dirname, '..', 'client', 'dist', '학생화면전송.exe'),
    type: 'application/octet-stream', name: '학생화면전송.exe' },
};
// 빌드 스크립트가 앱 파일 옆에 만든 버전 파일. APP_VERSION_DIR는 테스트에서만 바꾼다.
const appVersions = createAppVersions(process.env.APP_VERSION_DIR ? {
  windows: path.join(process.env.APP_VERSION_DIR, 'windows.json'),
  android: path.join(process.env.APP_VERSION_DIR, 'android.json'),
} : {
  windows: path.join(__dirname, '..', 'client', 'dist', 'version.json'),
  android: path.join(__dirname, '..', 'android', 'dist', 'version.json'),
});

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const download = Object.hasOwn(DOWNLOADS, url) ? DOWNLOADS[url] : null;
  if (download) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    return fs.stat(download.file, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('설치 파일이 없습니다. 선생님에게 앱 파일을 확인해 달라고 요청하세요.');
      }
      res.writeHead(200, { 'Content-Type': download.type, 'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="screen-monitor-student${path.extname(download.file)}"; filename*=UTF-8''${encodeURIComponent(download.name)}`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(download.file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  }
  const entry = Object.hasOwn(STATIC, url) ? STATIC[url] : null;
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  fs.readFile(path.join(__dirname, 'public', entry[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// 교사에게만 보낸다(교사 인증 뒤 created/resumed/connectionInfo 응답). Wi-Fi 비밀번호가 들어 있으므로 학생 쪽엔 절대 보내지 않는다.
function connectionInfo() {
  const address = server.address();
  return { addresses: lanAddresses(), port: address && typeof address === 'object' ? address.port : PORT, wifi: readWifi() };
}

// ---------- 세션 ----------
/** code -> classroom, recording state, teachers and students */
const sessions = new Map();

function newCode() {
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (sessions.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function toTeachers(session, data, isBinary) {
  for (const t of session.teachers) {
    if (t.readyState !== t.OPEN) continue;
    if (isBinary && t.bufferedAmount > MAX_TEACHER_BUFFER) continue;
    t.send(data, { binary: isBinary });
  }
}

function studentInfo(st) {
  return { id: st.id, grade: st.grade, cls: st.cls, num: st.num, name: st.name,
    online: !!st.ws, paused: !!st.paused, help: !!st.help, helpAt: st.helpAt || 0, notice: !!st.notice,
    platform: st.app?.platform || null, appVersion: st.app?.version || null,
    outdated: !!st.app?.outdated, latestVersion: st.app?.latestVersion || null };
}

function frameMessage(kind, id, jpeg) {
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(id, 1);
  return Buffer.concat([header, jpeg]);
}

function validJpeg(jpeg) {
  if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9) return false;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return false;
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > jpeg.length) return false;
    if (sof.has(marker)) {
      if (length < 8) return false;
      const height = jpeg.readUInt16BE(offset + 5), width = jpeg.readUInt16BE(offset + 7);
      return width > 0 && height > 0 && width * height <= 32 * 1024 * 1024 && [1, 3, 4].includes(jpeg[offset + 9]);
    }
    if (marker === 0xda) return false;
    offset += 2 + length;
  }
  return false;
}

async function endSession(session, reason) {
  if (session.ending) return;
  session.ending = true;
  toTeachers(session, JSON.stringify({ t: 'ending' }), false);
  if (!await recorder.finish(session)) {
    session.ending = false;
    toTeachers(session, JSON.stringify({ t: 'error', endFailed: true,
      msg: 'PDF 저장에 실패해 수업 종료를 보류했습니다. 저장을 재시도한 뒤 종료하세요.' }), false);
    return;
  }
  sessions.delete(session.code);
  reportLessons();
  for (const st of session.students.values()) {
    history.clearStudent(st);
    send(st.ws, { t: 'end', reason });
    if (st.ws) st.ws.close(1000, 'session end');
  }
  for (const t of session.teachers) {
    send(t, { t: 'ended', reason });
    t.close(1000, 'session end');
  }
  session.students.clear();
  console.log(`[세션 종료] ${session.code} (${reason})`);
}

// 교사 창마다 확대 대상을 유지해 다른 교사의 확대를 해제하지 않는다.
function updateFocus(session) {
  for (const st of session.students.values()) {
    const full = [...session.teachers].some(t => t.focusId === st.id);
    if (st.full !== full) { st.full = full; send(st.ws, { t: 'mode', full }); }
  }
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

// 비밀번호만 알면 진행 중인 수업 화면을 볼 수 있으므로, 기기(IP)별로 연속 실패를 막는다.
// 연결을 새로 열어도 초기화되지 않게 소켓이 아니라 주소 기준으로 센다.
const AUTH_LIMIT = 10, AUTH_LOCK_MS = 5 * 60 * 1000;
const authFailures = new Map(); // ip -> { count, since }
function authLocked(ip) {
  const entry = authFailures.get(ip);
  if (entry && Date.now() - entry.since > AUTH_LOCK_MS) authFailures.delete(ip);
  return (authFailures.get(ip)?.count || 0) >= AUTH_LIMIT;
}
function recordAuthFailure(ws) {
  const entry = authFailures.get(ws.ip) || { count: 0, since: Date.now() };
  entry.count++;
  authFailures.set(ws.ip, entry);
  if (++ws.authFailures >= 5) ws.close(1008, 'too many attempts');
}
function sendLocked(ws) {
  send(ws, { t: 'error', msg: '비밀번호나 QR을 여러 번 잘못 넣어 이 기기에서 5분간 로그인이 잠겼습니다.' });
}
function checkTeacherPassword(ws, password) {
  if (authLocked(ws.ip)) { sendLocked(ws); return false; }
  if (password === TEACHER_PASSWORD) { authFailures.delete(ws.ip); return true; }
  send(ws, { t: 'error', msg: '비밀번호가 틀렸습니다.' });
  recordAuthFailure(ws);
  return false;
}

// ---- 태블릿 연결 QR ----
// 노트북 화면은 프로젝터로 학생에게 보일 수 있으므로, QR 안의 열쇠는 한 번만 쓰이고 2분 뒤 사라진다.
// 열쇠는 주소의 # 뒤에 넣어 서버 요청 기록·브라우저 전송에 남지 않게 한다.
const PAIR_TTL_MS = 2 * 60 * 1000;
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function startPairing(ws, session) {
  const token = crypto.randomBytes(18).toString('hex');
  const expiresAt = Date.now() + PAIR_TTL_MS;
  session.pairing = { token, expiresAt };
  const { addresses, port } = connectionInfo();
  const url = addresses.length ? `http://${addresses[0].ip}:${port}/#pair=${session.code}.${token}` : null;
  const svg = url ? await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }) : null;
  // QR을 만드는 사이 새 QR 요청이나 태블릿 연결로 바뀌었다면 옛 QR은 보내지 않는다.
  if (session.pairing?.token !== token) return;
  send(ws, { t: 'pairQr', url, svg, expiresAt, ttlSec: PAIR_TTL_MS / 1000 });
}

// 노트북·태블릿 등 이 수업을 연 교사 화면 수를 모든 교사 화면에 알린다.
function broadcastTeachers(session) {
  toTeachers(session, JSON.stringify({ t: 'teachers', count: session.teachers.size }), false);
}

// 새로고침한 창(resume)과 다른 기기에서 합류한 창(attach)을 같은 방식으로 붙인다.
function addTeacher(ws, session) {
  session.teachers.add(ws); session.teacherlessSince = null;
  ws.role = 'teacher'; ws.code = session.code;
  send(ws, { t: 'resumed', code: session.code, token: session.token, lessonTitle: session.lessonTitle, connection: connectionInfo(), ending: !!session.ending, students: [...session.students.values()].map(studentInfo), save: recorder.info(session) });
  for (const st of session.students.values()) {
    if (st.lastThumb) ws.send(frameMessage(KIND_THUMB, st.id, st.lastThumb), { binary: true });
  }
  broadcastTeachers(session);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
// 포트 사용 중 같은 시작 오류는 아래 server 'error'에서 안내한다. 여기서 다시 던지면 안내 없이 죽는다.
wss.on('error', () => {});

wss.on('connection', (ws, req) => {
  ws.on('error', (error) => console.warn('[연결 오류]', error.message));
  // A browser on an unrelated site must not open this LAN service on the user's behalf.
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) { ws.close(1008, 'origin'); return; }
    } catch { ws.close(1008, 'origin'); return; }
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.role = null;
  ws.authFailures = 0;
  ws.ip = req.socket.remoteAddress || '';
  ws.connectedAt = Date.now();

  ws.on('message', (data, isBinary) => {
    // ----- 학생 화면 프레임 -----
    if (isBinary) {
      if (ws.role !== 'student') return;
      const session = sessions.get(ws.code);
      const st = session && session.students.get(ws.key);
      if (!st || st.ws !== ws || st.paused || data.length < 100) return;
      const kind = data[0];
      if (kind === 3) {
        const jpeg = data.subarray(5);
        if (session.saveOn && session.saveQuality === 'ai' && validJpeg(jpeg)) {
          captureRequests.accept(st, data.readUInt32BE(1), jpeg);
        }
        return;
      }
      if (session.ending) return;
      if (kind !== KIND_THUMB && kind !== KIND_FULL) return;
      const jpeg = data.subarray(1);
      if (!validJpeg(jpeg)) return;
      // Full mode sends only full frames: keep those fresh for recording and resume too.
      st.lastThumb = jpeg;
      st.lastFrameAt = Date.now();
      toTeachers(session, frameMessage(kind, st.id, jpeg), true);
      return;
    }

    let msg;
    if (data.length > 4096) { ws.close(1008, 'control message too large'); return; }
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    if (msg.t === 'ping') { send(ws, { t: 'pong' }); return; }
    if (msg.t === 'pause' && ws.role === 'student' && typeof msg.paused === 'boolean') {
      const session = sessions.get(ws.code);
      const st = session && session.students.get(ws.key);
      if (st && st.ws === ws) {
        st.paused = msg.paused;
        if (st.paused) captureRequests.cancel(st);
        toTeachers(session, JSON.stringify({ t: 'join', student: studentInfo(st) }), false);
      }
      return;
    }
    // 학생이 손을 들면 교사 화면 전체에 알린다. 교사가 확인하면 서버가 내려 준다.
    if (msg.t === 'help' && ws.role === 'student' && typeof msg.on === 'boolean') {
      const session = sessions.get(ws.code);
      const st = session && session.students.get(ws.key);
      if (st && st.ws === ws && st.help !== msg.on) {
        st.help = msg.on; st.helpAt = msg.on ? Date.now() : 0;
        toTeachers(session, JSON.stringify({ t: 'join', student: studentInfo(st) }), false);
      }
      return;
    }
    if (['create', 'resume', 'attach', 'pair', 'hello'].includes(msg.t) && ws.role) {
      return send(ws, { t: 'error', msg: '이미 등록된 연결입니다.' });
    }
    if (shuttingDown && !ws.role) { ws.close(1012, 'server shutdown'); return; }

    // ----- 교사 -----
    if (msg.t === 'create') {
      if (!checkTeacherPassword(ws, msg.password)) return;
      const session = {
        code: newCode(), token: crypto.randomBytes(24).toString('hex'),
        teachers: new Set([ws]), students: new Map(), nextId: 1, teacherlessSince: null,
        saveOn: false, saveStamp: null, saveQuality: msg.quality === 'ai' ? 'ai' : 'standard',
        saveIntervalMs: intervalMs(msg.interval),
        lessonTitle: normalizeLessonTitle(msg.lessonTitle),
      };
      sessions.set(session.code, session);
      reportLessons();
      if (SAVE_DEFAULT_ON) recorder.start(session);
      ws.role = 'teacher'; ws.code = session.code;
      send(ws, { t: 'created', code: session.code, token: session.token, lessonTitle: session.lessonTitle, connection: connectionInfo(), save: recorder.info(session) });
      broadcastTeachers(session);
      console.log(`[세션 생성] ${session.code}`);
      return;
    }
    if (msg.t === 'resume') {
      const session = sessions.get(String(msg.code));
      if (!session || session.token !== msg.token) return send(ws, { t: 'error', msg: '세션이 없거나 종료되었습니다.', resumeFailed: true });
      addTeacher(ws, session);
      return;
    }
    // 태블릿 등 다른 기기에서 진행 중인 수업에 교사 화면으로 합류한다.
    // 수업이 하나뿐이면 코드 없이도 들어가고, 여러 개면 코드로 고른다.
    if (msg.t === 'attach') {
      if (!checkTeacherPassword(ws, msg.password)) return;
      const wanted = clean(msg.code, 10);
      const open = [...sessions.values()].filter(s => !s.ending);
      const session = wanted ? sessions.get(wanted) : (open.length === 1 ? open[0] : null);
      if (!session || session.ending) {
        return send(ws, { t: 'error', msg: wanted ? '진행 중인 수업을 찾지 못했습니다. 수업 코드를 확인하세요.'
          : open.length ? '진행 중인 수업이 여러 개입니다. 수업 코드를 입력하세요.'
            : '진행 중인 수업이 없습니다. 교사 노트북에서 먼저 수업을 시작하세요.' });
      }
      addTeacher(ws, session);
      console.log(`[교사 화면 합류] ${session.code} (${ws.ip}) · 교사 화면 ${session.teachers.size}대`);
      return;
    }
    // 노트북이 띄운 QR을 태블릿이 찍어 들어온다. 열쇠는 한 번 쓰면 없어진다.
    if (msg.t === 'pair') {
      if (authLocked(ws.ip)) return sendLocked(ws);
      const session = sessions.get(clean(msg.code, 10));
      const pairing = session && session.pairing;
      if (!session || session.ending || !pairing || Date.now() > pairing.expiresAt || !sameSecret(pairing.token, msg.token)) {
        recordAuthFailure(ws);
        return send(ws, { t: 'error', msg: 'QR 코드가 만료되었거나 이미 사용되었습니다. 노트북에서 새 QR을 만들어 다시 찍으세요.' });
      }
      session.pairing = null;
      addTeacher(ws, session);
      for (const t of session.teachers) if (t !== ws) send(t, { t: 'paired' });
      console.log(`[태블릿 QR 연결] ${session.code} (${ws.ip}) · 교사 화면 ${session.teachers.size}대`);
      return;
    }
    if (ws.role === 'teacher') {
      const session = sessions.get(ws.code);
      if (!session || session.ending) return;
      if (msg.t === 'lessonTitle') {
        if (!updateLessonTitle(session, msg.lessonTitle)) {
          send(ws, { t: 'settingLocked', setting: 'title', lessonTitle: session.lessonTitle,
            msg: settingLockReason(session, 'title') || '지금은 수업명을 바꿀 수 없습니다.' });
        }
        return;
      }
      if (msg.t === 'connectionInfo') return send(ws, { t: 'connectionInfo', connection: connectionInfo() });
      if (msg.t === 'pairStart') {
        startPairing(ws, session).catch(e => send(ws, { t: 'error', msg: `QR을 만들지 못했습니다: ${e.message}` }));
        return;
      }
      if (msg.t === 'pairCancel') { session.pairing = null; return; }
      if (msg.t === 'focus') {
        if ([...session.students.values()].some(st => st.id === msg.id)) ws.focusId = msg.id;
        updateFocus(session);
      }
      else if (msg.t === 'unfocus') { ws.focusId = null; updateFocus(session); }
      else if (msg.t === 'history' || msg.t === 'historyFrame') {
        if (!Number.isSafeInteger(msg.requestId)) return;
        const st = [...session.students.values()].find(student => student.id === msg.id);
        const frames = st?.history || [];
        if (msg.t === 'history') {
          send(ws, { t: 'history', id: msg.id, requestId: msg.requestId,
            frames: frames.map(frame => ({ id: frame.id, at: frame.at })) });
        } else {
          const frame = frames.find(frame => frame.id === msg.frameId);
          send(ws, { t: 'historyFrame', id: msg.id, requestId: msg.requestId,
            frameId: msg.frameId, at: frame?.at,
            jpeg: frame ? Buffer.from(frame.bytes).toString('base64') : null });
        }
      }
      else if (msg.t === 'save') {
        if (typeof msg.on !== 'boolean') return;
        if (Object.hasOwn(msg, 'lessonTitle')) updateLessonTitle(session, msg.lessonTitle);
        // 저장 중지는 일시정지다. PDF는 수업 종료 때 학생별 1개로 만든다.
        // 단, PDF 저장 실패 뒤 누르는 버튼(재시도)은 바로 PDF 저장을 다시 시도한다.
        if (msg.on) recorder.start(session);
        else if (session.saveBatch) void recorder.finish(session);
        else void recorder.pause(session);
        broadcastSave(session);
      }
      else if (msg.t === 'saveQuality') {
        if (!['standard', 'ai'].includes(msg.quality)) return;
        // 일시정지 중에도 같은 PDF에 이어 쌓으므로 화질은 수업 종료까지 고정한다.
        const locked = settingLockReason(session, 'quality');
        if (locked) {
          send(ws, { t: 'settingLocked', setting: 'quality', msg: locked });
          return send(ws, { t: 'saveState', save: recorder.info(session) });
        }
        session.saveQuality = msg.quality;
        broadcastSave(session);
      }
      else if (msg.t === 'saveInterval') {
        if (!SAVE_INTERVAL_CHOICES.includes(Number(msg.interval))) return;
        const locked = settingLockReason(session, 'interval');
        if (locked) {
          send(ws, { t: 'settingLocked', setting: 'interval', msg: locked });
          return send(ws, { t: 'saveState', save: recorder.info(session) });
        }
        session.saveIntervalMs = intervalMs(msg.interval);
        broadcastSave(session);
      }
      else if (msg.t === 'message') {
        // 주소가 중간에 잘리면 링크가 죽으므로 넉넉하게 받는다.
        const text = clean(msg.text, 300);
        if (!text) return;
        const all = msg.id === null || msg.id === undefined;
        const targets = [...session.students.values()].filter(st => all || st.id === Number(msg.id));
        let delivered = 0, legacy = 0, offline = 0;
        for (const st of targets) {
          if (!st.ws) { offline++; continue; }
          // 구버전 학생 앱은 이 메시지를 표시하지 못하므로 보낸 척하지 않는다.
          if (!st.notice) { legacy++; continue; }
          send(st.ws, { t: 'notice', text, at: Date.now() });
          delivered++;
        }
        send(ws, { t: 'messageSent', all, id: all ? null : Number(msg.id), text, delivered, legacy, offline });
      }
      else if (msg.t === 'clearHelp') {
        const st = [...session.students.values()].find(student => student.id === Number(msg.id));
        if (st && st.help) {
          st.help = false; st.helpAt = 0;
          send(st.ws, { t: 'help', on: false });
          toTeachers(session, JSON.stringify({ t: 'join', student: studentInfo(st) }), false);
        }
      }
      else if (msg.t === 'end') {
        if (Object.hasOwn(msg, 'lessonTitle')) updateLessonTitle(session, msg.lessonTitle);
        endSession(session, '선생님이 수업을 종료했습니다.').catch((e) => console.error(e.message));
      }
      else if (msg.t === 'remove') {
        for (const [key, st] of session.students) {
          if (st.id === Number(msg.id) && !st.ws) {
            if (st.frames.length) return send(ws, { t: 'error', msg: '이 학생의 화면 기록은 수업 종료 때 PDF로 저장됩니다. 그 전에는 지울 수 없습니다.' });
            history.clearStudent(st);
            session.students.delete(key);
            toTeachers(session, JSON.stringify({ t: 'removed', id: st.id }), false);
          }
        }
      }
      return;
    }

    // ----- 학생 -----
    if (msg.t === 'hello') {
      const session = sessions.get(clean(msg.code, 10));
      if (!session || session.ending) return send(ws, { t: 'error', msg: '수업 코드가 올바르지 않거나 수업이 종료 중입니다.', fatal: true });
      const grade = clean(msg.grade, 10), cls = clean(msg.cls, 10), num = clean(msg.num, 10), name = clean(msg.name, 20);
      if (![grade, cls, num].every(v => /^[1-9]\d?$/.test(v)) || !name) return send(ws, { t: 'error', msg: '학년, 반, 번호는 1~99의 숫자로, 이름은 빈칸 없이 입력하세요.', fatal: true });
      const key = `${grade}|${cls}|${num}`;
      let st = session.students.get(key);
      // A run-specific random key permits recovery before a sleeping socket times out.
      // Another student's duplicate number still cannot replace an active connection.
      const resumeKey = typeof msg.resumeKey === 'string' && /^[a-f0-9-]{32,64}$/i.test(msg.resumeKey) ? msg.resumeKey : null;
      const sameRun = resumeKey && st && st.resumeKey === resumeKey;
      if (st && st.ws && st.ws !== ws && st.ws.readyState === st.ws.OPEN && !sameRun) {
        send(ws, { t: 'error', msg: '같은 학년·반·번호가 이미 접속 중입니다. 기존 프로그램을 종료하거나 번호를 확인하세요.', fatal: true });
        return;
      }
      if (!st) {
        st = { id: session.nextId++, key, grade, cls, num, name, ws: null, lastThumb: null, lastFrameAt: 0, frames: [] };
        session.students.set(key, st);
      }
      const previous = st.ws;
      captureRequests.cancel(st);
      st.name = name; st.ws = ws; st.highCapture = msg.highCapture === true;
      st.notice = msg.notice === true; st.help = msg.help === true;
      st.helpAt = st.help ? (st.helpAt || Date.now()) : 0;
      st.resumeKey = resumeKey; st.paused = msg.paused === true;
      // 이 교사 서버에 든 학생 앱보다 오래된 앱이면 새 앱에 '새 버전 받기'를, 교사 화면에 표시를 띄운다.
      st.app = appVersions.check(msg);
      if (previous && previous !== ws) previous.terminate();
      ws.role = 'student'; ws.code = session.code; ws.key = key;
      send(ws, { t: 'ok', id: st.id, recording: session.saveOn, captureQuality: session.saveQuality || 'standard',
        update: st.app.update });
      if (st.full) send(ws, { t: 'mode', full: true });
      toTeachers(session, JSON.stringify({ t: 'join', student: studentInfo(st) }), false);
      toTeachers(session, JSON.stringify({ t: 'saveState', save: recorder.info(session) }), false);
      console.log(`[학생 접속] ${session.code} ${grade}학년 ${cls}반 ${num}번 ${name}` +
        (st.app.outdated ? ` · 구버전 앱(${st.app.version || '버전 정보 없음'} → ${st.app.latestVersion})` : ''));
      return;
    }
  });

  ws.on('close', () => {
    const session = sessions.get(ws.code);
    if (!session) return;
    if (ws.role === 'teacher') {
      session.teachers.delete(ws);
      if (session.teachers.size === 0) {
        session.teacherlessSince = Date.now();
      }
      updateFocus(session);
      broadcastTeachers(session);
    } else if (ws.role === 'student') {
      const st = session.students.get(ws.key);
      if (st && st.ws === ws) {
        captureRequests.cancel(st);
        if (session.saveQuality !== 'ai' || !st.highCapture) recorder.capture(session, st);
        st.ws = null;
        toTeachers(session, JSON.stringify({ t: 'leave', id: st.id }), false);
        toTeachers(session, JSON.stringify({ t: 'saveState', save: recorder.info(session) }), false);
      }
    }
  });
});

// 끊긴 연결 정리 + 교사 없는 세션 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.role && Date.now() - ws.connectedAt > 30000) { ws.terminate(); continue; }
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.teacherlessSince && now - session.teacherlessSince > TEACHERLESS_TIMEOUT_MS) {
      endSession(session, '선생님 연결이 오래 끊겨 수업이 종료되었습니다.').catch((e) => console.error(e.message));
    }
  }
}, 15000);

// A short scheduler honors each class's own recording start time.
setInterval(() => {
  for (const session of sessions.values()) recorder.tick(session);
}, 100);

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `[시작 실패] 포트 ${PORT}를 다른 프로그램이 사용 중입니다. 기존 서버를 확인하세요.`
    : `[서버 오류] ${error.message}`);
  // Windows의 파이프 출력은 비동기라, 실행기가 이유를 읽도록 다 쓴 뒤에 끈다.
  if (CONTROL_STDIN) process.stdout.write('@@' + JSON.stringify({ t: 'error', code: error.code || 'ERROR' }) + '\n', () => process.exit(1));
  else process.exit(1);
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  control({ t: 'shuttingDown', lessons: sessions.size });
  for (const session of sessions.values()) await endSession(session, '서버가 종료되었습니다.');
  if (sessions.size) { shuttingDown = false; control({ t: 'shutdownFailed', lessons: sessions.size }); return; }
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  // 브라우저의 유휴 연결이 남아 close가 늦어져도 PDF는 이미 저장됐으므로 곧 끈다.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows에서 서버 창(콘솔)을 닫으면 SIGHUP이 온다. 모아 둔 캡처를 PDF로 저장하려고 시도한다(몇 초 안에 끝나야 함).
process.on('SIGHUP', shutdown);

// 교사용 실행기(트레이 앱)가 서버를 창 없이 띄울 때 쓰는 제어 통로(CONTROL_STDIN=1).
// 표준 입력으로 'shutdown' 한 줄을 받으면 수업을 모두 끝내 PDF를 저장한 뒤 꺼진다.
// 실행기가 먼저 죽어 입력이 끊겨도 같은 순서로 저장하고 끈다.
// 상태는 '@@{json}' 한 줄로 표준 출력에 알린다(ready/lessons/shuttingDown/shutdownFailed/error).
function control(event) {
  if (CONTROL_STDIN) process.stdout.write('@@' + JSON.stringify(event) + '\n');
}
function reportLessons() {
  control({ t: 'lessons', count: sessions.size });
}
if (CONTROL_STDIN) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => { if (line.trim() === 'shutdown') void shutdown(); });
  lines.on('close', () => void shutdown());
}

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  if (process.send) process.send({ port: server.address().port });
  control({ t: 'ready', port: server.address().port });
  const ips = lanAddresses();
  const line = '='.repeat(52);
  console.log('\n' + line);
  console.log('  학생 화면 모니터 서버가 켜졌습니다.');
  console.log(line);
  console.log('  [교사] 이 컴퓨터의 브라우저에서 열기:');
  console.log(`         http://localhost:${PORT}`);
  console.log('');
  console.log('  [학생] 프로그램의 "서버 주소" 칸에 아래를 입력:');
  if (ips.length) {
    const real = ips.filter((x) => !x.virtual);
    (real.length ? real : ips).forEach((x, i) => {
      const tag = i === 0 ? '  <- 보통 이 주소' : (x.virtual ? '  (가상 어댑터)' : '');
      console.log(`         ${x.ip}:${PORT}   [${x.iface}]${tag}`);
    });
  } else {
    console.log('         (네트워크 주소를 찾지 못했습니다. ipconfig 확인)');
  }
  const wifi = readWifi();
  if (wifi.ssid) console.log(`  Wi-Fi: ${wifi.ssid}   (비밀번호는 교사 화면의 접속 정보 창에 표시)`);
  console.log('');
  console.log(`  교사 비밀번호: ${TEACHER_PASSWORD === 'teacher1234' ? 'teacher1234 (기본값)' : '설정됨'}`);
  console.log(`  화면 저장: 수업 시작 시 ${SAVE_DEFAULT_ON ? '켜짐' : '꺼짐'} (교사 화면에서 켜고 끌 수 있음)`);
  console.log(`            기본 간격 ${SAVE_INTERVAL_MS / 1000}초 (교사 화면에서 ${SAVE_INTERVAL_CHOICES.join('/')}초 중 선택)`);
  console.log(`            폴더: ${SAVE_DIR}`);
  console.log('  종료 전 교사 화면에서 수업 종료를 눌러 PDF 저장을 완료하세요.');
  console.log(line + '\n');
});
