// 교사 서버가 나눠 주는 학생 앱(EXE·APK)의 버전을 알고, 접속한 학생 앱이 그보다 오래됐는지 판단한다.
// 버전 파일(dist/version.json)은 빌드 스크립트가 앱 파일 옆에 만든다. 없으면 업데이트 안내를 하지 않는다.
const fs = require('node:fs');

const DOWNLOAD = { windows: '/download/windows', android: '/download/android' };

function parts(version) {
  return String(version ?? '').split('.').map(n => Number.parseInt(n, 10) || 0);
}
// a가 b보다 낮으면 음수, 같으면 0, 높으면 양수.
function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function createAppVersions(files) {
  const cache = new Map(); // platform -> { mtimeMs, value }
  function latest(platform) {
    const file = files[platform];
    if (!file) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { cache.delete(platform); return null; }
    const hit = cache.get(platform);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
    let value = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data.version === 'string' && /^\d+(\.\d+){0,3}$/.test(data.version)) {
        value = { version: data.version, build: Number.isSafeInteger(data.build) ? data.build : null };
      }
    } catch { value = null; }
    cache.set(platform, { mtimeMs: stat.mtimeMs, value });
    return value;
  }

  // hello 메시지로 학생 앱을 판정한다. 버전을 보내지 않는 앱은 이 기능 이전의 구버전이다.
  // (구버전 Windows 앱은 platform도 보내지 않았고, Android는 1.4.0부터 platform을 보냈다.)
  function check(hello) {
    const platform = hello.platform === 'android' ? 'android' : 'windows';
    const version = typeof hello.version === 'string' && /^\d+(\.\d+){0,3}$/.test(hello.version) ? hello.version : null;
    const build = Number.isSafeInteger(hello.build) ? hello.build : null;
    const newest = latest(platform);
    let outdated = false;
    if (newest) {
      if (!version) outdated = true;
      else if (platform === 'android' && newest.build !== null && build !== null) outdated = build < newest.build;
      else outdated = compareVersions(version, newest.version) < 0;
    }
    return {
      platform, version, outdated,
      latestVersion: newest ? newest.version : null,
      // 새 앱에만 의미가 있다. 구버전 앱은 이 필드를 모르고 무시한다.
      update: outdated ? { version: newest.version, url: DOWNLOAD[platform] } : null,
    };
  }

  return { latest, check };
}

module.exports = { createAppVersions, compareVersions };
