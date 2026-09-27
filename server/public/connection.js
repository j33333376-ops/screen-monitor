// This window receives only classroom joining details, never a teacher token or student frames.
const address = document.getElementById('address');
const classCode = document.getElementById('classCode');
const status = document.getElementById('status');
const addresses = document.getElementById('addresses');
let selected = '', port = 8080, lastUpdate = 0;
function renderAddress() {
  selected = addresses.value;
  address.textContent = selected ? selected + ':' + port : '연결된 네트워크가 없습니다';
}
addresses.onchange = renderAddress;

// ---- Wi-Fi 이름·비밀번호 ----
// 서버가 교사 PC의 Wi-Fi를 자동 감지해 보내 주지만, 학생용 Wi-Fi가 다르면 교사가 이 창에서 직접 입력한다.
// 직접 입력한 값은 이 브라우저(localStorage)에 남아 다음 수업에도 유지된다.
const wifiSsid = document.getElementById('wifiSsid');
const wifiKey = document.getElementById('wifiKey');
const wifiSection = document.getElementById('wifiSection');
const wifiToggle = document.getElementById('wifiToggle');
const keyToggle = document.getElementById('keyToggle');
const wifiForm = document.getElementById('wifiForm');
const wifiEdit = document.getElementById('wifiEdit');
const wifiSsidInput = document.getElementById('wifiSsidInput');
const wifiKeyInput = document.getElementById('wifiKeyInput');
const wifiSource = document.getElementById('wifiSource');
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* 저장 불가 브라우저 */ } },
};
let autoWifi = { ssid: '', key: '', supported: false };
let wifiOverride = null;
try { wifiOverride = JSON.parse(store.get('sm_wifi_override') || 'null'); } catch { wifiOverride = null; }
if (wifiOverride && typeof wifiOverride.ssid !== 'string') wifiOverride = null;
if (store.get('sm_wifi_show') === 'off') wifiToggle.checked = false;
if (store.get('sm_wifi_key_show') === 'off') keyToggle.checked = false;

function effectiveWifi() { return wifiOverride || autoWifi; }
function renderWifi() {
  const wifi = effectiveWifi();
  wifiSection.classList.toggle('hidden', !wifiToggle.checked);
  wifiSsid.textContent = wifi.ssid || '‘Wi-Fi 정보 수정’으로 입력';
  wifiSsid.classList.toggle('muted', !wifi.ssid);
  const masked = !keyToggle.checked;
  wifiKey.classList.toggle('masked', masked);
  if (masked) wifiKey.textContent = '●●●●●●';
  else wifiKey.textContent = wifi.key || (wifi.ssid ? '없음(개방형) · 다르면 수정' : '‘Wi-Fi 정보 수정’으로 입력');
  wifiKey.classList.toggle('muted', !masked && !wifi.key);
  wifiSource.textContent = wifiOverride ? '직접 입력한 값을 표시 중' :
    autoWifi.supported ? '교사 PC의 Wi-Fi를 자동 감지한 값' : '자동 감지 불가 · 직접 입력하세요';
}
wifiToggle.onchange = () => { store.set('sm_wifi_show', wifiToggle.checked ? null : 'off'); renderWifi(); };
keyToggle.onchange = () => { store.set('sm_wifi_key_show', keyToggle.checked ? null : 'off'); renderWifi(); };
let wifiFormOpen = false;
function setWifiForm(open) {
  wifiFormOpen = open;
  wifiForm.classList.toggle('hidden', !open);
  wifiEdit.setAttribute('aria-expanded', String(open));
  if (open) {
    const wifi = effectiveWifi();
    wifiSsidInput.value = wifi.ssid || '';
    wifiKeyInput.value = wifi.key || '';
    wifiSsidInput.focus();
  }
}
wifiEdit.onclick = () => setWifiForm(!wifiFormOpen);
wifiForm.onsubmit = event => {
  event.preventDefault();
  wifiOverride = { ssid: wifiSsidInput.value.trim().slice(0, 64), key: wifiKeyInput.value.trim().slice(0, 64) };
  store.set('sm_wifi_override', JSON.stringify(wifiOverride));
  renderWifi();
  setWifiForm(false);
};
document.getElementById('wifiAuto').onclick = () => {
  wifiOverride = null;
  store.set('sm_wifi_override', null);
  renderWifi();
  setWifiForm(false);
};
renderWifi();

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.opener || event.data?.t !== 'classConnection') return;
  const data = event.data;
  lastUpdate = Date.now();
  const options = data.connection?.addresses || [];
  port = data.connection?.port || 8080;
  addresses.textContent = '';
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.ip;
    option.textContent = item.ip + ' · ' + item.iface + (item.virtual ? ' (가상 네트워크)' : '');
    addresses.appendChild(option);
  }
  if (options.some(item => item.ip === selected)) addresses.value = selected;
  document.getElementById('addressChoice').classList.toggle('hidden', options.length <= 1);
  renderAddress();
  const wifi = data.connection?.wifi;
  if (wifi && typeof wifi === 'object') {
    autoWifi = { ssid: String(wifi.ssid || ''), key: String(wifi.key || ''), supported: !!wifi.supported };
  }
  renderWifi();
  classCode.textContent = data.code || '------';
  status.textContent = !data.code ? '수업이 종료되었습니다.' : !data.connected ?
    '서버 연결 복구 중 · 잠시 기다려 주세요.' : '학생 앱의 주소 칸과 수업 코드를 위와 같게 입력하세요.';
});
const fullscreen = document.getElementById('fullscreen');
fullscreen.onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { status.textContent = '창을 최대화해서 사용해 주세요.'; }
};
document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? '전체 화면 종료' : '전체 화면';
});
if (window.opener) window.opener.postMessage({ t: 'connectionReady' }, location.origin);
else status.textContent = '교사 화면의 ‘IP·수업 코드 띄우기’ 버튼으로 열어 주세요.';
setInterval(() => {
  if (!window.opener || window.opener.closed) {
    classCode.textContent = '------';
    status.textContent = '교사 화면이 닫혔습니다.';
  } else {
    window.opener.postMessage({ t: 'connectionReady' }, location.origin);
    if (lastUpdate && Date.now() - lastUpdate > 15000) {
      classCode.textContent = '------';
      status.textContent = '교사 화면의 연결을 확인해 주세요.';
    }
  }
}, 5000);
