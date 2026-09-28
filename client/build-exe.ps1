# Windows 학생 앱(EXE)을 만든다: 테스트 → PyInstaller → dist\version.json(교사 서버의 새 버전 안내용).
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$match = Select-String -LiteralPath (Join-Path $PSScriptRoot 'student.py') -Pattern '^APP_VERSION = "(\d+(\.\d+){0,3})"'
if (-not $match) { throw 'student.py에서 APP_VERSION을 찾지 못했습니다.' }
$version = $match.Matches[0].Groups[1].Value
if (Get-Process -Name '학생화면전송' -ErrorAction SilentlyContinue) {
    throw '학생화면전송.exe가 실행 중입니다. 트레이 아이콘을 우클릭해 종료한 뒤 다시 빌드하세요.'
}
python -m unittest
if ($LASTEXITCODE -ne 0) { throw '테스트가 실패해 EXE를 만들지 않았습니다.' }
python -m PyInstaller --noconfirm --onefile --noconsole --name '학생화면전송' student.py
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller 빌드에 실패했습니다.' }
$exe = Join-Path $PSScriptRoot 'dist\학생화면전송.exe'
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'dist\version.json'),
    "{`"version`": `"$version`"}`n", [System.Text.UTF8Encoding]::new($false))
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$exe.sha256", "$hash  학생화면전송.exe`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "EXE ready: $exe (version $version)"