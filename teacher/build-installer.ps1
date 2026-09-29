# 교사용 배포 파일을 만든다: 테스트 → 실행기 EXE(PyInstaller) → 설치 폴더 조립 → 설치 파일(Inno Setup) + 휴대용 zip.
# 결과: %LOCALAPPDATA%\ScreenMonitorBuild\teacher\out\screen-monitor-teacher-setup.exe, screen-monitor-teacher.zip
# OneDrive 폴더 안에서 빌드하면 동기화가 파일을 잠가 PyInstaller가 실패하므로 빌드 폴더는 밖에 둔다.
param([switch]$SkipServerTests)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$root = Split-Path -Parent $PSScriptRoot
$match = Select-String -LiteralPath (Join-Path $PSScriptRoot 'launcher.py') -Pattern '^APP_VERSION = "([0-9.]+)"'
if (-not $match) { throw 'launcher.py에서 APP_VERSION을 찾지 못했습니다.' }
$version = $match.Matches[0].Groups[1].Value
if (Get-Process -Name '학생화면모니터' -ErrorAction SilentlyContinue) {
    throw '학생화면모니터.exe가 실행 중입니다. 트레이 아이콘에서 종료한 뒤 다시 빌드하세요.'
}
$iscc = @("$env:LOCALAPPDATA\Programs\Inno\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6(ISCC.exe)을 찾지 못했습니다. https://jrsoftware.org/isdl.php 에서 설치하세요.' }
$node = Join-Path $root 'server\node.exe'
foreach ($need in @($node, (Join-Path $root 'client\dist\학생화면전송.exe'), (Join-Path $root 'client\dist\version.json'),
        (Join-Path $root 'android\dist\학생화면전송.apk'), (Join-Path $root 'android\dist\version.json'))) {
    if (-not (Test-Path -LiteralPath $need)) { throw "필요한 파일이 없습니다: $need" }
}

python -m unittest
if ($LASTEXITCODE -ne 0) { throw '실행기 테스트가 실패했습니다.' }
if (-not $SkipServerTests) {
    Push-Location (Join-Path $root 'server')
    & $node --test --test-timeout=60000 test/
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw '서버 테스트가 실패했습니다.' }
}

$build = Join-Path $env:LOCALAPPDATA 'ScreenMonitorBuild\teacher'
New-Item -ItemType Directory -Path $build -Force | Out-Null
python -m PyInstaller --noconfirm --onedir --noconsole --name '학생화면모니터' --icon (Join-Path $PSScriptRoot 'icon.ico') `
    --distpath (Join-Path $build 'dist') --workpath (Join-Path $build 'work') --specpath $build launcher.py
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller 빌드에 실패했습니다.' }

# 설치될 폴더 모양 그대로 조립한다. server가 ..\client\dist, ..\android\dist 를 찾으므로 상대 위치를 지킨다.
$stage = Join-Path $build 'stage'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Path (Join-Path $build 'dist\학생화면모니터\*') -Destination $stage -Recurse
New-Item -ItemType Directory -Path (Join-Path $stage 'server') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'server') | Where-Object { $_.Name -ne 'test' } |
    Copy-Item -Destination (Join-Path $stage 'server') -Recurse
foreach ($dist in @('client\dist', 'android\dist')) {
    $to = Join-Path $stage $dist
    New-Item -ItemType Directory -Path $to -Force | Out-Null
    Copy-Item -Path (Join-Path $root "$dist\*") -Destination $to
}
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $stage

$out = Join-Path $build 'out'
New-Item -ItemType Directory -Path $out -Force | Out-Null
& $iscc "/DAppVersion=$version" "/DStageDir=$stage" "/O$out" (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup 빌드에 실패했습니다.' }

# 휴대용 zip: 설치 없이 압축을 풀고 학생화면모니터.exe를 실행한다. 최상위 폴더 이름은 screen-monitor.
$zip = Join-Path $out 'screen-monitor-teacher.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
$zipBase = Join-Path $build 'zip'
if (Test-Path -LiteralPath $zipBase) { Remove-Item -LiteralPath $zipBase -Recurse -Force }
$zipRoot = Join-Path $zipBase 'screen-monitor'
New-Item -ItemType Directory -Path $zipRoot | Out-Null
Copy-Item -Path "$stage\*" -Destination $zipRoot -Recurse
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($zipRoot, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)

foreach ($file in @((Join-Path $out 'screen-monitor-teacher-setup.exe'), $zip)) {
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $name = Split-Path -Leaf $file
    [System.IO.File]::WriteAllText("$file.sha256", "$hash  $name`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host ("{0}  {1:N1} MB" -f $name, ((Get-Item -LiteralPath $file).Length / 1MB))
}
Write-Host "교사용 배포 파일 준비 완료 (버전 $version): $out"
