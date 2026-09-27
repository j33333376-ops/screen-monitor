// 교사 PC가 붙어 있는 Wi-Fi 이름(SSID)과 비밀번호를 netsh로 읽는다. (Windows 전용, 관리자 권한 불필요)
// 학생에게 보여주는 접속 정보 창에서 쓰며, 교사가 화면에서 직접 고칠 수 있으므로 자동 감지는 "기본값" 역할만 한다.
const { execFileSync } = require('child_process');

// netsh 출력은 콘솔 코드 페이지를 따른다. 서버시작.bat(chcp 65001)에서는 UTF-8,
// 그냥 실행한 cmd 창에서는 CP949로 나오므로 UTF-8로 먼저 읽고 실패하면 EUC-KR로 읽는다.
function decodeConsole(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('euc-kr').decode(buffer); }
    catch { return buffer.toString('latin1'); }
  }
}

function field(text, labels) {
  const re = new RegExp('^[ \\t]*(?:' + labels.join('|') + ')[ \\t]*:[ \\t]*(.*?)[ \\t\\r]*$', 'mi');
  const m = re.exec(text);
  return m ? m[1] : '';
}

// `netsh wlan show interfaces` 출력에서 연결된 SSID와 프로필 이름을 찾는다. (한국어/영어 Windows)
function parseInterfaces(text) {
  // "AP BSSID" 줄은 제외되도록 줄 시작에 SSID 라벨이 오는 경우만 본다.
  const ssid = field(text, ['SSID']);
  const profile = field(text, ['프로필', 'Profile']);
  return { ssid, profile: profile || ssid };
}

// `netsh wlan show profile name=... key=clear` 출력에서 비밀번호를 찾는다. 개방형 네트워크면 빈 문자열.
function parseProfileKey(text) {
  return field(text, ['키 콘텐츠', 'Key Content']);
}

function netsh(args) {
  return decodeConsole(execFileSync('netsh', ['wlan', ...args], { timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
}

let cache = { at: 0, value: null };
const CACHE_MS = 20 * 1000;

// { ssid, key, supported } — 감지 실패나 비 Windows에서는 ssid·key가 빈 문자열이다.
function readWifi() {
  if (process.platform !== 'win32') return { ssid: '', key: '', supported: false };
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = { ssid: '', key: '', supported: true };
  try {
    const { ssid, profile } = parseInterfaces(netsh(['show', 'interfaces']));
    value.ssid = ssid;
    if (profile) {
      try { value.key = parseProfileKey(netsh(['show', 'profile', `name=${profile}`, 'key=clear'])); }
      catch { value.key = ''; }
    }
  } catch { /* Wi-Fi 서비스가 없거나 netsh 실패: 빈 값 유지 */ }
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { readWifi, parseInterfaces, parseProfileKey, decodeConsole };
