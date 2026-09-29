; 교사 노트북용 설치 파일(Inno Setup 6). build-installer.ps1이 준비한 폴더(build\stage)를 묶는다.
; 관리자 권한 없이 사용자 폴더에 설치되고, 관리자로 설치하면 방화벽 허용도 함께 할 수 있다.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "build\stage"
#endif

[Setup]
AppId={{8C1F6E2A-5B7D-4E3A-9F21-5C2D7A1B9E40}
AppName=학생 화면 모니터
AppVersion={#AppVersion}
AppVerName=학생 화면 모니터 {#AppVersion}
AppPublisher=학생 화면 모니터 프로젝트
AppPublisherURL=https://github.com/j33333376-ops/screen-monitor
AppSupportURL=https://github.com/j33333376-ops/screen-monitor
DefaultDirName={autopf}\ScreenMonitor
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=build\out
OutputBaseFilename=screen-monitor-teacher-setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\학생화면모니터.exe
UninstallDisplayName=학생 화면 모니터
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕 화면에 아이콘 만들기"
Name: "firewall"; Description: "Windows 방화벽에서 학생 접속(TCP 8080) 허용"; Check: IsAdminInstallMode

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\학생 화면 모니터"; Filename: "{app}\학생화면모니터.exe"
Name: "{autodesktop}\학생 화면 모니터"; Filename: "{app}\학생화면모니터.exe"; Tasks: desktopicon

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""screen-monitor-8080"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""screen-monitor-8080"" dir=in action=allow protocol=TCP localport=8080"; Flags: runhidden; Tasks: firewall
Filename: "{app}\학생화면모니터.exe"; Description: "학생 화면 모니터 실행"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""screen-monitor-8080"""; Flags: runhidden; RunOnceId: "RemoveFirewallRule"; Check: IsAdminInstallMode

[Code]
{ 실행 중이면 트레이 종료와 같은 순서(수업 종료 -> PDF 저장 -> 종료)로 먼저 끈다. 강제로 끄지 않는다. }
function CloseRunningApp(): Boolean;
var
  Exe: String;
  Code: Integer;
begin
  Result := True;
  Exe := ExpandConstant('{app}\학생화면모니터.exe');
  if FileExists(Exe) then
  begin
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Result := (Code = 0);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not CloseRunningApp() then
    Result := '학생 화면 모니터가 PDF 저장을 끝내지 못해 아직 실행 중입니다. 트레이 아이콘에서 종료한 뒤 다시 설치하세요.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := CloseRunningApp();
  if not Result then
    MsgBox('학생 화면 모니터가 PDF 저장을 끝내지 못해 아직 실행 중입니다. 트레이 아이콘에서 종료한 뒤 다시 제거하세요.', mbError, MB_OK);
end;
