const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInterfaces, parseProfileKey, decodeConsole } = require('../wifi-info');

const KO_INTERFACES = `
시스템에 1 인터페이스가 있습니다. 

    이름                   : Wi-Fi
    상태                   : 연결됨
    SSID                   : SK_A10E_5G
    AP BSSID               : 28:4e:e9:5c:a1:10
    프로필                : SK_A10E_5G 
`;
const EN_INTERFACES = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    State                  : connected
    SSID                   : Class Room 3-2
    AP BSSID               : 28:4e:e9:5c:a1:10
    Profile                : Class Room 3-2
`;
const KO_PROFILE = `
    SSID 개수        : 1
    SSID 이름              : "SK_A10E_5G"
보안 설정
---------
    보안 키           : 있음
    키 콘텐츠            : AQD5C@9366
`;
const EN_PROFILE = `
Security settings
-----------------
    Security key           : Present
    Key Content            : pass word 1
`;

test('SSID and profile are parsed from Korean and English netsh output, ignoring the AP BSSID line', () => {
  assert.deepEqual(parseInterfaces(KO_INTERFACES), { ssid: 'SK_A10E_5G', profile: 'SK_A10E_5G' });
  assert.deepEqual(parseInterfaces(EN_INTERFACES), { ssid: 'Class Room 3-2', profile: 'Class Room 3-2' });
  assert.deepEqual(parseInterfaces('    상태 : 연결 끊김'), { ssid: '', profile: '' });
});

test('Wi-Fi key is parsed from Korean and English profile output; open networks give an empty key', () => {
  assert.equal(parseProfileKey(KO_PROFILE), 'AQD5C@9366');
  assert.equal(parseProfileKey(EN_PROFILE), 'pass word 1');
  assert.equal(parseProfileKey('    보안 키           : 없음'), '');
});

test('console output is decoded as UTF-8 first and CP949 otherwise', () => {
  assert.equal(decodeConsole(Buffer.from('SSID : 학교', 'utf8')), 'SSID : 학교');
  const cp949 = Buffer.from([0x53, 0x53, 0x49, 0x44, 0x20, 0x3a, 0x20, 0xc7, 0xd0, 0xb1, 0xb3]); // "SSID : 학교"
  assert.equal(decodeConsole(cp949), 'SSID : 학교');
});
