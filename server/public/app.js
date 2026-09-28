// 교사 화면 클라이언트
const $ = (id) => document.getElementById(id);
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

let ws, code, token;
const tiles = new Map();   // id -> { el, img, info, url, lastAt }
let focusId = null;
let reconnectTimer, connected = false, ending = false, savePending = false;
let lastReceivedAt = 0, lastConnectionAt = 0, lastWakeCheck = Date.now();
let historyFrames = [], captureId = null, historyLoading = false, historyError = '';
let requestSerial = 0, historyRequest = 0, frameRequest = 0;
let classConnection = { addresses: [], port: 8080 }, connectionWindow = null;
let lessonTitleDirty = false, submittedLessonTitle = null;
let helpPanelOpen = false;

function setHelpPanel(open, restoreFocus = false) {
  helpPanelOpen = open;
  $('helpPanel').classList.toggle('hidden', !open);
  $('helpBtn').setAttribute('aria-expanded', String(open));
  if (restoreFocus) $('helpBtn').focus();
}
$('helpBtn').onclick = () => {
  setHelpPanel(!helpPanelOpen);
  if (helpPanelOpen) $('helpClose').focus();
};
$('helpClose').onclick = () => setHelpPanel(false, true);
$('settingsBtn').onclick = () => {
  setHelpPanel(false);
  $('settingsDialog').showModal();
  $('settingsClose').focus();
};
$('settingsClose').onclick = () => $('settingsDialog').close();
document.addEventListener('click', event => {
  if (helpPanelOpen && !$('helpPanel').contains(event.target) && !$('helpBtn').contains(event.target)) setHelpPanel(false);
});

function receiveLessonTitle(title = '') {
  if (lessonTitleDirty && $('lessonTitle').value !== submittedLessonTitle) return;
  $('lessonTitle').value = title;
  lessonTitleDirty = false;
  submittedLessonTitle = null;
  $('lessonTitleStatus').textContent = title
    ? '적용됨 · PDF 이름: 수업명_학년·반_날짜_학생 정보'
    : '수업명 미입력 · PDF 이름: 학년·반_날짜_학생 정보';
}
$('lessonTitle').oninput = () => {
  lessonTitleDirty = true;
  $('lessonTitleStatus').textContent = '수업명 적용을 누르세요. 저장 중지·수업 종료 때도 자동 반영됩니다.';
};
$('lessonTitleBtn').onclick = () => {
  submittedLessonTitle = $('lessonTitle').value;
  if (send({ t: 'lessonTitle', lessonTitle: submittedLessonTitle })) {
    $('lessonTitleStatus').textContent = '수업명 적용 중…';
  }
};
$('lessonTitle').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) $('lessonTitleBtn').click();
});

// QR을 못 쓸 때 태블릿에서 직접 주소를 입력해 여는 방법을 수업 설정 창에 적어 둔다.
function updateTabletInfo() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const first = (classConnection.addresses || [])[0];
  const host = !local ? location.host : first ? `${first.ip}:${classConnection.port}` : '';
  $('tabletInfo').textContent = host
    ? `QR이 안 되면: 태블릿 브라우저에서 http://${host} 접속 → 교사 비밀번호와 수업 코드 ${code || '------'} 입력 → '진행 중인 수업 열기'. 노트북 창을 닫아도 태블릿에서 수업이 계속됩니다.`
    : '이 PC의 네트워크 주소를 찾지 못했습니다. Wi-Fi 연결을 확인하세요.';
}

// ---------- 태블릿 연결 QR ----------
// QR 안의 열쇠는 한 번 쓰면 사라지고 2분 뒤 만료된다(서버가 판정). 여기서는 남은 시간만 보여 준다.
let pairTimer = null, pairExpiresAt = 0;
function stopPairCountdown() { clearInterval(pairTimer); pairTimer = null; }
function hidePairQr() {
  $('pairQr').classList.add('hidden');
  $('pairQr').removeAttribute('src');
  $('pairUrl').textContent = '';
}
function openPairDialog() {
  $('settingsDialog').close();
  stopPairCountdown();
  hidePairQr();
  $('pairRenew').classList.add('hidden');
  $('pairStatus').textContent = 'QR을 만드는 중…';
  if (!$('pairDialog').open) $('pairDialog').showModal();
  if (!send({ t: 'pairStart' })) {
    $('pairStatus').textContent = '서버 연결이 끊겨 QR을 만들지 못했습니다.';
    $('pairRenew').classList.remove('hidden');
  }
}
function showPairQr(msg) {
  if (!$('pairDialog').open) return;
  if (!msg.svg) {
    $('pairStatus').textContent = '이 PC의 네트워크 주소를 찾지 못했습니다. Wi-Fi 연결을 확인하세요.';
    $('pairRenew').classList.remove('hidden');
    return;
  }
  $('pairQr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(msg.svg);
  $('pairQr').classList.remove('hidden');
  // 열쇠(# 뒤)는 글자로 보여 주지 않는다.
  $('pairUrl').textContent = `태블릿 주소: ${msg.url.split('#')[0]}`;
  $('pairRenew').classList.add('hidden');
  pairExpiresAt = Date.now() + msg.ttlSec * 1000;
  stopPairCountdown();
  tickPair();
  pairTimer = setInterval(tickPair, 1000);
}
function tickPair() {
  const left = Math.ceil((pairExpiresAt - Date.now()) / 1000);
  if (left <= 0) {
    stopPairCountdown();
    hidePairQr();
    $('pairStatus').textContent = 'QR이 만료되었습니다.';
    $('pairRenew').classList.remove('hidden');
    return;
  }
  $('pairStatus').textContent = `남은 시간 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · 한 번 찍으면 사라집니다`;
}
function pairedDone() {
  stopPairCountdown();
  hidePairQr();
  $('pairRenew').classList.add('hidden');
  $('pairStatus').textContent = '✅ 태블릿이 연결되었습니다.';
  setTimeout(() => $('pairDialog').close(), 1500);
}
$('pairBtn').onclick = openPairDialog;
$('pairRenew').onclick = openPairDialog;
$('pairClose').onclick = () => $('pairDialog').close();
// 닫기·Esc 어느 쪽이든 남은 QR 열쇠를 바로 없앤다.
$('pairDialog').addEventListener('close', () => {
  stopPairCountdown();
  hidePairQr();
  send({ t: 'pairCancel' });
});

function publishConnectionInfo() {
  updateTabletInfo();
  if (connectionWindow && !connectionWindow.closed) {
    connectionWindow.postMessage({ t: 'classConnection', code: code || '', connected,
      connection: classConnection }, location.origin);
  }
}

$('connectionBtn').onclick = () => {
  if (!connectionWindow || connectionWindow.closed) {
    connectionWindow = window.open('/connection', '_blank', 'popup,width=1000,height=720');
  }
  if (connectionWindow) {
    connectionWindow.focus();
    publishConnectionInfo();
  } else {
    $('saveNotice').textContent = '접속 정보 창을 열려면 이 사이트의 팝업을 허용해 주세요.';
    $('settingsBtn').classList.add('attention');
    $('settingsBtn').title = $('saveNotice').textContent;
  }
};
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.data?.t !== 'connectionReady') return;
  // Recover the projection window after the teacher tab is refreshed.
  if (!connectionWindow && event.source && event.source.opener === window) connectionWindow = event.source;
  if (event.source === connectionWindow) {
    // Refresh the PC's addresses when opening the projection window.
    send({ t: 'connectionInfo' });
    publishConnectionInfo();
  }
});

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !connected) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function connectionState(value, text) {
  connected = value;
  publishConnectionInfo();
  $('connectionStatus').textContent = text;
  $('connectionStatus').title = text;
  $('connectionStatus').classList.toggle('disconnected', !value);
  $('endBtn').disabled = !value || ending;
  $('confirmEnd').disabled = !value || ending;
  showSaveInfo();
  updateHistoryControls();
}

function clearCredentials() {
  sessionStorage.removeItem('sm_code');
  sessionStorage.removeItem('sm_token');
}

function resetSession(message) {
  code = token = null;
  lessonTitleDirty = false;
  submittedLessonTitle = null;
  $('initialLessonTitle').value = '';
  receiveLessonTitle('');
  publishConnectionInfo();
  ending = false;
  clearTimeout(reconnectTimer);
  closeModal();
  $('endDialog').close();
  $('msgDialog').close();
  $('settingsDialog').close();
  $('pairDialog').close();
  setHelpPanel(false);
  clearCredentials();
  for (const id of [...tiles.keys()]) removeTile(id);
  $('main').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginMsg').textContent = message;
  showTeacherCount(1);
  setLoginBusy(false);
  if (ws) ws.close();
}

function setLoginBusy(busy) {
  $('createBtn').disabled = busy;
  $('joinBtn').disabled = busy;
}

function showTeacherCount(count) {
  $('teacherCount').textContent = `교사 화면 ${count}대`;
  $('teacherCount').classList.toggle('hidden', !(count > 1));
}

function connect(onOpen) {
  clearTimeout(reconnectTimer);
  const previous = ws;
  const socket = new WebSocket(wsUrl);
  ws = socket;
  lastReceivedAt = lastConnectionAt = Date.now();
  if (previous) previous.close();
  socket.binaryType = 'arraybuffer';
  connectionState(false, code ? '다시 연결 중…' : '연결 중…');
  const timeout = setTimeout(() => { if (!connected && ws === socket) socket.close(); }, 10000);
  socket.onopen = () => { if (ws === socket) onOpen(socket); };
  socket.onmessage = (event) => { if (ws === socket) { lastReceivedAt = Date.now(); onMessage(event); } };
  socket.onclose = () => {
    clearTimeout(timeout);
    if (ws !== socket) return;
    savePending = false;
    connectionState(false, '연결 끊김 · 다시 연결 중…');
    if (code && token) {
      reconnectTimer = setTimeout(() => connect(s => s.send(JSON.stringify({ t: 'resume', code, token }))), 1500);
    } else {
      setLoginBusy(false);
      if (!$('loginMsg').textContent) $('loginMsg').textContent = '서버에 연결할 수 없습니다. 서버 실행 여부를 확인하세요.';
    }
  };
}

$('createBtn').onclick = () => {
  const password = $('password').value;
  if (!password) return;
  if ($('createBtn').disabled) return;
  setLoginBusy(true);
  $('loginMsg').textContent = '';
  const quality = $('initialQuality').value;
  const interval = Number($('initialInterval').value);
  const lessonTitle = $('initialLessonTitle').value;
  connect(s => s.send(JSON.stringify({ t: 'create', password, quality, interval, lessonTitle })));
};
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });

// 노트북에서 이미 시작한 수업을 태블릿 등 다른 기기에서 교사 화면으로 연다.
$('joinBtn').onclick = () => {
  const password = $('password').value;
  if (!password) { $('loginMsg').textContent = '위 칸에 교사 비밀번호를 입력하세요.'; $('password').focus(); return; }
  if ($('joinBtn').disabled) return;
  setLoginBusy(true);
  $('loginMsg').textContent = '';
  const joinCode = $('joinCode').value.replace(/\D/g, '');
  connect(s => s.send(JSON.stringify({ t: 'attach', password, code: joinCode })));
};
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) $('joinBtn').click(); });

$('endBtn').onclick = () => {
  setHelpPanel(false);
  $('endDialog').showModal();
  $('cancelEnd').focus();
};
$('cancelEnd').onclick = () => $('endDialog').close();
$('confirmEnd').onclick = () => {
  submittedLessonTitle = $('lessonTitle').value;
  if (send({ t: 'end', lessonTitle: submittedLessonTitle })) {
    ending = true;
    $('endDialog').close();
    $('endBtn').disabled = true;
    showSaveInfo();
  }
};
$('sizeRange').oninput = (e) => {
  document.documentElement.style.setProperty('--tile', e.target.value + 'px');
};
$('modalClose').onclick = closeModal;
$('historyPrev').onclick = previousCapture;
$('historyNext').onclick = nextCapture;
$('historyLive').onclick = showLive;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    if (helpPanelOpen) setHelpPanel(false, true);
  }
  if (focusId === null || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); previousCapture(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); nextCapture(); }
});

function onMessage(ev) {
  if (typeof ev.data !== 'string') return onFrame(ev.data);
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'created':
    case 'resumed':
      code = msg.code; token = msg.token;
      receiveLessonTitle(msg.lessonTitle);
      if (msg.connection) classConnection = msg.connection;
      ending = !!msg.ending;
      savePending = false;
      connectionState(true, '서버 연결됨');
      $('password').value = '';
      sessionStorage.setItem('sm_code', code);
      sessionStorage.setItem('sm_token', token);
      $('login').classList.add('hidden');
      $('main').classList.remove('hidden');
      $('code').textContent = code;
      if (msg.students) {
        const ids = new Set(msg.students.map(s => s.id));
        for (const id of [...tiles.keys()]) if (!ids.has(id)) removeTile(id);
        for (const s of msg.students) upsert(s);
      }
      if (focusId !== null) {
        send({ t: 'focus', id: focusId });
        requestHistory();
        if (captureId !== null) showCapture(captureId);
      }
      showSaveInfo(msg.save);
      updateCount();
      break;
    case 'connectionInfo':
      classConnection = msg.connection;
      publishConnectionInfo();
      break;
    case 'teachers': showTeacherCount(msg.count); break;
    case 'pairQr': showPairQr(msg); break;
    case 'paired': pairedDone(); break;
    case 'lessonTitle': receiveLessonTitle(msg.lessonTitle); break;
    case 'saveState': savePending = false; showSaveInfo(msg.save); break;
    case 'messageSent': showMessageResult(msg); break;
    case 'historyChanged':
      if (msg.id === focusId) requestHistory();
      break;
    case 'history':
      if (msg.id !== focusId || msg.requestId !== historyRequest) break;
      historyFrames = msg.frames;
      if (captureId !== null && !historyFrames.some(frame => frame.id === captureId)) {
        showLive();
        historyError = '보관 한도로 이전 캡처가 정리되어 실시간으로 돌아왔습니다.';
      }
      updateHistoryControls();
      break;
    case 'historyFrame':
      if (msg.id !== focusId || msg.requestId !== frameRequest || msg.frameId !== captureId) break;
      historyLoading = false;
      if (msg.jpeg) {
        const bytes = Uint8Array.from(atob(msg.jpeg), c => c.charCodeAt(0));
        setModalImage(new Blob([bytes], { type: 'image/jpeg' }));
      } else {
        historyError = '이 캡처는 보관 기간이 지나 더 이상 볼 수 없습니다.';
        requestHistory();
      }
      updateHistoryControls();
      break;
    case 'join': upsert(msg.student); updateCount(); break;
    case 'leave': setOnline(msg.id, false); updateCount(); break;
    case 'removed': removeTile(msg.id); updateCount(); break;
    case 'ending':
      ending = true;
      $('endBtn').disabled = true;
      $('saveNotice').textContent = '화면 기록을 저장하고 수업을 종료하는 중…';
      showSaveInfo();
      break;
    case 'ended':
      resetSession(msg.reason || '수업이 종료되었습니다.');
      break;
    case 'error':
      if (msg.resumeFailed) { resetSession(msg.msg); break; }
      if (code) {
        $('saveNotice').textContent = msg.msg;
        if (msg.endFailed) { ending = false; connectionState(connected, '서버 연결됨'); }
        $('settingsBtn').classList.add('attention');
        $('settingsBtn').title = msg.msg;
      } else {
        $('loginMsg').textContent = msg.msg;
        setLoginBusy(false);
        ws.close();
      }
      break;
  }
}

function onFrame(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 6) return;
  const view = new DataView(buf);
  const kind = view.getUint8(0);          // 1=썸네일 2=고화질
  const id = view.getUint32(1);
  if (kind !== 1 && kind !== 2) return;
  const t = tiles.get(id);
  if (!t) return;
  const blob = new Blob([buf.slice(5)], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  if (t) {
    if (t.url) URL.revokeObjectURL(t.url);
    t.url = url; t.blob = blob; t.img.src = url; t.lastAt = Date.now();
    t.el.querySelector('.stale').style.display = 'none';
  }
  if (focusId === id && captureId === null) setModalImage(blob);
}

function upsert(info) {
  let t = tiles.get(info.id);
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML = `<img alt=""><span class="badge">접속</span><span class="hand" title="도움 요청">✋</span>
      <button class="remove" title="끊긴 학생 지우기">✕</button>
      <span class="stale">연결 대기…</span>
      <span class="label"><b></b><small></small></span>`;
    el.onclick = () => openModal(info.id);
    el.onkeydown = (event) => {
      if (event.target !== el) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openModal(info.id); }
    };
    el.querySelector('.remove').onclick = (e) => {
      e.stopPropagation();
      send({ t: 'remove', id: info.id });
    };
    $('grid').appendChild(el);
    t = { el, img: el.querySelector('img'), info, url: null, lastAt: 0 };
    tiles.set(info.id, t);
  }
  t.info = info;
  const gradePart = info.grade ? `${info.grade}학년 ` : '';
  t.el.querySelector('.label b').textContent = `${gradePart}${info.cls}반 ${info.num}번`;
  t.el.querySelector('.label small').textContent = info.name;
  t.el.setAttribute('aria-label', `${info.grade}학년 ${info.cls}반 ${info.num}번 ${info.name} 화면 확대`);
  [...tiles.values()].sort((a, b) =>
    Number(a.info.grade) - Number(b.info.grade) || Number(a.info.cls) - Number(b.info.cls) || Number(a.info.num) - Number(b.info.num)
  ).forEach((tile, index) => {
    // Help/status updates must not remove and reinsert unchanged tiles (scroll anchoring/focus).
    const current = $('grid').children[index];
    if (current !== tile.el) $('grid').insertBefore(tile.el, current || null);
  });
  setOnline(info.id, info.online);
}

function setOnline(id, online) {
  const t = tiles.get(id); if (!t) return;
  t.info.online = online;
  t.el.classList.toggle('offline', !online);
  t.el.classList.toggle('raised', !!t.info.help);
  const badge = t.el.querySelector('.badge');
  if (badge) badge.textContent = online ? (t.info.paused ? '화면 꺼짐' : '접속') : '재연결 대기';
  updateHelpBar();
}

// ---------- 도움 요청 ----------
let helpSeen = new Set();
function raisedStudents() {
  return [...tiles.values()].filter(t => t.info.help)
    .sort((a, b) => (a.info.helpAt || 0) - (b.info.helpAt || 0));
}

function updateHelpBar() {
  const raised = raisedStudents();
  const bar = $('helpBar');
  $('helpCount').textContent = String(raised.length);
  $('helpBtn').classList.toggle('active', raised.length > 0);
  $('helpBtn').title = raised.length ? `도움 요청 ${raised.length}명 · 눌러서 확인` : '호출한 학생 목록 열기';
  bar.textContent = '';
  if (raised.length) {
    const title = document.createElement('b');
    title.textContent = `✋ 도움 요청 ${raised.length}명`;
    bar.appendChild(title);
    for (const t of raised) {
      const button = document.createElement('button');
      button.textContent = `${t.info.grade}학년 ${t.info.cls}반 ${t.info.num}번 ${t.info.name}`;
      button.title = '누르면 이 학생 화면을 확대하고 손을 내립니다.';
      button.onclick = () => { setHelpPanel(false); openModal(t.info.id); send({ t: 'clearHelp', id: t.info.id }); };
      bar.appendChild(button);
    }
    const clearAll = document.createElement('button');
    clearAll.className = 'ghost';
    clearAll.textContent = '모두 확인';
    clearAll.onclick = () => { for (const t of raisedStudents()) send({ t: 'clearHelp', id: t.info.id }); };
    bar.appendChild(clearAll);
  } else bar.textContent = '지금은 호출한 학생이 없습니다.';
  // 새로 올라온 손만 소리로 알린다. 다른 창을 보고 있어도 알아차리도록.
  const ids = new Set(raised.map(t => t.info.id));
  for (const id of ids) if (!helpSeen.has(id)) beep();
  helpSeen = ids;
  if (focusId !== null) $('modalHelp').classList.toggle('hidden', !tiles.get(focusId)?.info.help);
}

let audio;
function beep() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(); osc.stop(audio.currentTime + 0.36);
  } catch { /* 소리를 못 내도 화면 표시는 그대로 동작한다. */ }
}

// ---------- 메시지 보내기 ----------
const QUICK_MESSAGES = ['화면에서 눈을 떼고 선생님을 봐 주세요', '지금까지 한 것을 저장하세요',
  '다음 활동으로 넘어가 주세요', '잘하고 있어요 👍'];
let msgTargetId = null;

function openMessageDialog(id) {
  $('settingsDialog').close();
  msgTargetId = id ?? null;
  const t = msgTargetId === null ? null : tiles.get(msgTargetId);
  $('msgTarget').textContent = t
    ? `받는 사람: ${t.info.cls}반 ${t.info.num}번 ${t.info.name}`
    : `받는 사람: 접속한 학생 전체 (${[...tiles.values()].filter(x => x.info.online).length}명)`;
  $('msgResult').textContent = '';
  updateMessageHint();
  const quick = $('msgQuick');
  quick.textContent = '';
  for (const text of QUICK_MESSAGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.onclick = () => { $('msgText').value = text; updateMessageHint(); $('msgText').focus(); };
    quick.appendChild(button);
  }
  $('msgDialog').showModal();
  $('msgText').focus();
}

// 학생 앱이 링크로 만들어 주는 것과 같은 형태만 안내에 쓴다.
const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function updateMessageHint() {
  const links = $('msgText').value.match(LINK_PATTERN) || [];
  $('msgHint').textContent = links.length
    ? `링크 ${links.length}개 · 학생 앱에서 누르면 브라우저가 열립니다.`
    : '';
}

function sendMessage() {
  const text = $('msgText').value.trim();
  if (!text) return;
  if (!send({ t: 'message', id: msgTargetId, text })) {
    $('msgResult').textContent = '서버 연결이 끊겨 보내지 못했습니다.';
  }
}

function showMessageResult(msg) {
  const parts = [`${msg.delivered}명에게 보냈습니다.`];
  if (msg.legacy) parts.push(`${msg.legacy}명은 구버전 학생 앱이라 받지 못했습니다.`);
  if (msg.offline) parts.push(`${msg.offline}명은 접속이 끊겨 있습니다.`);
  $('msgResult').textContent = parts.join(' ');
  if (msg.delivered) $('msgText').value = '';
  $('saveNotice').textContent = `메시지 전송: “${msg.text}” · ${parts.join(' ')}`;
}

$('msgBtn').onclick = () => openMessageDialog(null);
$('modalMsg').onclick = () => openMessageDialog(focusId);
$('msgCancel').onclick = () => $('msgDialog').close();
$('msgSend').onclick = sendMessage;
$('msgText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });
$('msgText').addEventListener('input', updateMessageHint);
$('modalHelp').onclick = () => { if (focusId !== null) send({ t: 'clearHelp', id: focusId }); };

function removeTile(id) {
  if (focusId === id) closeModal();
  const t = tiles.get(id); if (!t) return;
  if (t.url) URL.revokeObjectURL(t.url);
  t.el.remove(); tiles.delete(id);
  updateHelpBar();
}

let saveState = { on: false, intervalSec: 30, dir: '' };
function showSaveInfo(save) {
  if (save) saveState = save;
  const titleLocked = !connected || ending || savePending || !!saveState.busy || !!saveState.retry;
  $('lessonTitle').disabled = titleLocked;
  $('lessonTitleBtn').disabled = titleLocked;
  $('saveQuality').value = saveState.quality || 'standard';
  const locked = !connected || ending || savePending || saveState.on || !!saveState.busy || !!saveState.retry;
  $('saveQuality').disabled = locked;
  const select = $('saveInterval');
  const choices = (saveState.intervalChoices || [30]).map(Number);
  if (select.dataset.choices !== choices.join(',')) {
    select.dataset.choices = choices.join(',');
    select.textContent = '';
    for (const sec of choices) {
      const option = document.createElement('option');
      option.value = sec;
      option.textContent = `${sec}초마다`;
      select.appendChild(option);
    }
  }
  select.value = String(saveState.intervalSec ?? 30);
  select.disabled = locked;
  $('qualityNotice').textContent = (saveState.quality === 'ai'
    ? 'AI 분석용 · 긴 변 최대 2560px, JPEG 품질 85 · 저장 시점에 별도 촬영하며 파일 용량이 커집니다.'
    : '기본 · 현재 화면 화질로 저장합니다.') + (saveState.on ? ' 화질을 바꾸려면 저장을 중지하세요.' : ' 저장 화질을 선택하고 저장 시작을 누르세요.');
  $('saveWarning').textContent = saveState.warning || '';
  const needsAttention = !!(saveState.error || saveState.retry || saveState.warning);
  $('settingsBtn').classList.toggle('attention', needsAttention);
  $('settingsBtn').title = needsAttention
    ? '저장 알림이 있습니다. 수업 설정에서 확인하세요.'
    : '수업명, 저장 설정, 메시지, 화면 크기';
  updateHistoryControls();
  const el = $('saveBtn');
  if (!el) return;
  el.classList.remove('hidden');
  el.disabled = !connected || ending || savePending || !!saveState.busy;
  if (ending) {
    el.textContent = '수업 종료 중…';
    $('saveNotice').textContent = '화면 기록을 저장하고 수업을 종료하는 중…';
    return;
  }
  if (saveState.busy) {
    el.textContent = 'PDF 저장 중…';
    $('saveNotice').textContent = '마지막 캡처를 수집하고 PDF 파일을 만드는 중입니다. 완료할 때까지 서버를 켜 두세요.';
    return;
  }
  if (saveState.retry) {
    el.textContent = 'PDF 저장 재시도';
    $('saveNotice').textContent = saveState.error;
    return;
  }
  $('saveNotice').textContent = saveState.error || saveState.result || (saveState.on ? '화면 기록 수집 중 · 저장 중지 또는 수업 종료 시 PDF가 만들어집니다.' : '화면 기록 저장 꺼짐');
  if (saveState.on) {
    el.textContent = '● 저장 중지';
    el.classList.add('on');
    el.title = `${saveState.intervalSec}초 간격으로 기록 중 · 누르면 PDF로 저장하고 기록을 멈춥니다.\n저장 폴더: ${saveState.dir}`;
  } else {
    el.textContent = '○ 저장 시작';
    el.classList.remove('on');
    el.title = '저장 폴더: ' + saveState.dir + '\n누르면 이 수업 화면을 저장하기 시작합니다.';
  }
}
$('saveBtn').onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) { $('saveNotice').textContent = '서버 연결이 끊겨 있습니다. 잠시 후 다시 시도하세요.'; return; }
  const turningOn = !saveState.on;
  if (saveState.busy || savePending || ending) return;
  submittedLessonTitle = $('lessonTitle').value;
  if (!send({ t: 'save', on: saveState.retry ? false : turningOn, lessonTitle: submittedLessonTitle })) return;
  savePending = true;
  showSaveInfo();
  $('saveBtn').disabled = true;
  // 응답이 올 때까지 버튼에 처리 중 표시(대화상자 차단 환경에서도 동작하도록 confirm 미사용)
  $('saveBtn').textContent = turningOn ? '저장 시작 중…' : '저장 중지 중…';
};

$('saveQuality').onchange = () => {
  if (!send({ t: 'saveQuality', quality: $('saveQuality').value })) return;
  savePending = true;
  showSaveInfo();
};

$('saveInterval').onchange = () => {
  if (!send({ t: 'saveInterval', interval: Number($('saveInterval').value) })) return;
  savePending = true;
  showSaveInfo();
};

function updateCount() {
  const n = [...tiles.values()].filter((t) => t.info.online).length;
  $('onlineCount').textContent = n;
  $('emptyHint').classList.toggle('hidden', tiles.size > 0);
}

function openModal(id) {
  if (focusId !== null) closeModal();
  focusId = id;
  historyFrames = []; captureId = null; historyLoading = false; historyError = '';
  const t = tiles.get(id);
  $('modalTitle').textContent = t ? `${t.info.grade ? t.info.grade + '학년 ' : ''}${t.info.cls}반 ${t.info.num}번 ${t.info.name}` : '';
  setModalImage(t?.blob);
  $('modal').classList.remove('hidden');
  $('modalClose').focus();
  send({ t: 'focus', id });
  requestHistory();
  updateHistoryControls();
  updateHelpBar();
}
function closeModal() {
  if (focusId != null) send({ t: 'unfocus' });
  const previous = focusId;
  focusId = null;
  historyFrames = []; captureId = null; historyLoading = false; historyError = '';
  historyRequest = frameRequest = ++requestSerial;
  setModalImage(null);
  $('modal').classList.add('hidden');
  $('modalHelp').classList.add('hidden');
  if (tiles.has(previous)) tiles.get(previous).el.focus();
}

function setModalImage(blob) {
  const img = $('modalImg');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  delete img.dataset.url;
  img.removeAttribute('src');
  if (blob) img.src = img.dataset.url = URL.createObjectURL(blob);
  img.alt = captureId === null ? '학생의 최신 수신 화면' : '학생의 이전 캡처 화면';
}

function requestHistory() {
  if (focusId === null) return;
  historyRequest = ++requestSerial;
  send({ t: 'history', id: focusId, requestId: historyRequest });
}

function updateHistoryControls() {
  const index = historyFrames.findIndex(frame => frame.id === captureId);
  const unavailable = !connected || ending || historyLoading;
  $('historyPrev').disabled = unavailable || !(captureId === null ? historyFrames.length : index > 0);
  $('historyNext').disabled = unavailable || captureId === null;
  $('historyLive').disabled = captureId === null;
  let status;
  if (captureId === null) {
    status = historyFrames.length ? `실시간 · 이전 캡처 ${historyFrames.length}장` :
      (saveState.on ? `실시간 · 아직 캡처가 없습니다 (${saveState.intervalSec}초 간격으로 수집)` :
        '실시간 · 저장 시작을 누르면 이전 캡처가 쌓입니다');
  } else {
    const frame = historyFrames[index];
    status = frame ? `이전 캡처 ${index + 1} / ${historyFrames.length} · ${new Date(frame.at).toLocaleString('ko-KR', { hour12: false })}` : '이전 캡처';
    if (historyLoading) status += ' · 불러오는 중…';
  }
  if (!connected) status += ' · 서버 연결 끊김';
  $('historyStatus').textContent = historyError || status;
}

function showCapture(id) {
  if (!connected || ending) return;
  captureId = id; historyLoading = true; historyError = '';
  frameRequest = ++requestSerial;
  setModalImage(null);
  send({ t: 'historyFrame', id: focusId, frameId: id, requestId: frameRequest });
  updateHistoryControls();
}

function previousCapture() {
  if ($('historyPrev').disabled) return;
  const index = captureId === null ? historyFrames.length : historyFrames.findIndex(frame => frame.id === captureId);
  if (index > 0) showCapture(historyFrames[index - 1].id);
}

function nextCapture() {
  if ($('historyNext').disabled) return;
  const index = historyFrames.findIndex(frame => frame.id === captureId);
  if (index >= 0 && index + 1 < historyFrames.length) showCapture(historyFrames[index + 1].id);
  else showLive();
}

function showLive() {
  captureId = null; historyLoading = false; historyError = '';
  frameRequest = ++requestSerial;
  setModalImage(tiles.get(focusId)?.blob);
  updateHistoryControls();
}

// 오래된(멈춘) 타일 표시
setInterval(() => {
  const now = Date.now();
  for (const t of tiles.values()) {
    const stale = t.el.querySelector('.stale');
    if (!stale) continue;
    stale.style.display = (t.info.online && (t.info.paused || t.lastAt === 0 || now - t.lastAt > 8000)) ? 'flex' : 'none';
    stale.textContent = t.info.paused ? '화면 꺼짐 · 잠금 해제 대기' : t.lastAt ? '화면 수신 지연' : '화면 수신 대기…';
  }
}, 2000);

// A half-open socket need not deliver onclose after a laptop wakes up.
function checkConnectionAfterWake(force = false) {
  const now = Date.now();
  const woke = now - lastWakeCheck > 15000;
  lastWakeCheck = now;
  if (!code || !token || now - lastConnectionAt < 1500) return;
  if (force || woke || now - lastReceivedAt > 15000 || !ws || ws.readyState === WebSocket.CLOSED) {
    connect(s => s.send(JSON.stringify({ t: 'resume', code, token })));
  } else if (connected) send({ t: 'ping' });
}
setInterval(checkConnectionAfterWake, 5000);
window.addEventListener('online', () => checkConnectionAfterWake(true));
window.addEventListener('pageshow', (event) => { if (event.persisted) checkConnectionAfterWake(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkConnectionAfterWake();
});

// 태블릿이 노트북의 QR을 찍어 열었으면 그 수업에 바로 연결한다. 아니면 새로고침 시 세션 복구.
const PAIR_HASH = /^#pair=(\d{6})\.([a-f0-9]{36})$/;
// 이미 이 페이지가 열린 탭으로 QR을 열면 브라우저가 # 뒤만 바꾸고 다시 읽지 않으므로 직접 새로 읽는다.
window.addEventListener('hashchange', () => { if (PAIR_HASH.test(location.hash)) location.reload(); });
(function () {
  const pair = PAIR_HASH.exec(location.hash || '');
  if (pair) {
    // 열쇠가 주소창·방문 기록에 남지 않게 지운다(한 번 쓰면 어차피 무효).
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 지우지 못해도 연결은 진행 */ }
    clearCredentials();
    setLoginBusy(true);
    $('loginMsg').textContent = '태블릿을 수업에 연결하는 중…';
    connect(s => s.send(JSON.stringify({ t: 'pair', code: pair[1], token: pair[2] })));
    return;
  }
  const c = sessionStorage.getItem('sm_code'), tk = sessionStorage.getItem('sm_token');
  if (c && tk) { code = c; token = tk; setLoginBusy(true); connect(s => s.send(JSON.stringify({ t: 'resume', code, token }))); }
})();
