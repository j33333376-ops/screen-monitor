$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# An explicit environment variable wins. Otherwise look for the toolchain this project installs
# without administrator rights, then Android Studio's own. Finding it here means the batch file
# works from a plain double-click even before a sign-out refreshes the user environment.
function Find-Tool([string[]]$candidates, [string]$marker) {
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate $marker))) { return $candidate }
    }
    return $null
}
if (-not $env:ANDROID_HOME) {
    $env:ANDROID_HOME = Find-Tool @('C:\Users\Public\ScreenMonitor\Sdk',
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) 'platform-tools'
}
if (-not $env:ANDROID_HOME -or -not (Test-Path -LiteralPath $env:ANDROID_HOME)) {
    throw 'Android SDK not found. Set ANDROID_HOME, or install SDK platform 36 / Build Tools 36.1.0.'
}
if (-not $env:JAVA_HOME) {
    $env:JAVA_HOME = Find-Tool @('C:\Users\Public\ScreenMonitor\jdk-17',
        'C:\Program Files\Android\Android Studio\jbr') 'bin\keytool.exe'
}
$keytool = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\keytool.exe' } else { '' }
if (-not (Test-Path -LiteralPath $keytool)) { throw 'JDK 17 or newer is required. Set JAVA_HOME to its folder.' }
$hasher = [System.Security.Cryptography.SHA256]::Create()
$projectHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot))).Replace('-', '').Substring(0, 12)
$hasher.Dispose()
# A JDK on a non-English Windows reads Gradle's UTF-8 @argfile with the ANSI code page, so a
# classpath entry holding non-ASCII characters (a Korean account folder) breaks the test worker
# with ClassNotFoundException. Keep every generated path ASCII; the project may stay where it is.
function Test-AsciiPath([string]$path) { return $path -notmatch '[^\x20-\x7E]' }
$localRoot = Join-Path $env:LOCALAPPDATA 'ScreenMonitor'
$buildRoot = if (Test-AsciiPath $localRoot) { $localRoot } else { 'C:\Users\Public\ScreenMonitor' }
$env:SCREEN_MONITOR_BUILD_DIR = Join-Path $buildRoot "build-$projectHash"
$projectCache = Join-Path $env:SCREEN_MONITOR_BUILD_DIR 'gradle-cache'
if (-not $env:GRADLE_USER_HOME) {
    $gradleHome = Join-Path $env:USERPROFILE '.gradle'
    if (-not (Test-AsciiPath $gradleHome)) { $env:GRADLE_USER_HOME = Join-Path $buildRoot 'gradle-home' }
}

$keyFile = Join-Path $PSScriptRoot 'signing\student-release.jks'
$propertiesFile = Join-Path $PSScriptRoot 'keystore.properties'
if (-not (Test-Path -LiteralPath $propertiesFile)) {
    if (Test-Path -LiteralPath $keyFile) { throw 'Existing signing key found without keystore.properties. Restore its settings instead of replacing the key.' }
    New-Item -ItemType Directory -Force -Path (Split-Path $keyFile) | Out-Null
    $secretBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($secretBytes)
    $rng.Dispose()
    $env:SCREEN_MONITOR_SIGNING_PASSWORD = [Convert]::ToBase64String($secretBytes)
    try {
        & $keytool -genkeypair -keystore $keyFile -storetype PKCS12 -alias screenmonitor -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Screen Monitor Local Distribution' -storepass:env SCREEN_MONITOR_SIGNING_PASSWORD -keypass:env SCREEN_MONITOR_SIGNING_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed.' }
        $settings = "storeFile=signing/student-release.jks`nstorePassword=$env:SCREEN_MONITOR_SIGNING_PASSWORD`nkeyAlias=screenmonitor`nkeyPassword=$env:SCREEN_MONITOR_SIGNING_PASSWORD`n"
        [System.IO.File]::WriteAllText($propertiesFile, $settings, [System.Text.Encoding]::ASCII)
    } finally { Remove-Item Env:SCREEN_MONITOR_SIGNING_PASSWORD -ErrorAction SilentlyContinue }
}

& "$PSScriptRoot\gradlew.bat" --no-daemon --project-cache-dir $projectCache :app:testDebugUnitTest :app:lintRelease :app:assembleRelease
if ($LASTEXITCODE -ne 0) { throw 'Build or verification failed. APK was not published.' }
$output = Join-Path $PSScriptRoot 'dist\학생화면전송.apk'
$candidate = Join-Path $env:SCREEN_MONITOR_BUILD_DIR 'app\outputs\apk\release\app-release.apk'
$signer = Join-Path $env:ANDROID_HOME 'build-tools\36.1.0\apksigner.bat'
& $signer verify --verbose $candidate
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
New-Item -ItemType Directory -Force -Path (Split-Path $output) | Out-Null
Copy-Item -LiteralPath $candidate -Destination $output -Force
# The teacher server compares connecting apps with this file to offer "new version" prompts.
$gradle = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app\build.gradle') -Raw
$versionCode = [regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value
$versionName = [regex]::Match($gradle, "versionName\s+'(\d+(\.\d+){0,3})'").Groups[1].Value
if (-not $versionCode -or -not $versionName) { throw 'versionCode/versionName not found in app/build.gradle.' }
[System.IO.File]::WriteAllText((Join-Path (Split-Path $output) 'version.json'),
    "{`"version`": `"$versionName`", `"build`": $versionCode}`n", [System.Text.UTF8Encoding]::new($false))
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$output.sha256", "$hash  학생화면전송.apk`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "APK ready: $output"
