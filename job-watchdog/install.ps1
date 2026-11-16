# התקנה של שומר המשימות. מופעל דרך install.bat (לא צריך מנהל).
# מעתיק ל-%USERPROFILE%\job-watchdog, בוחר משימות למעקב, מגדיר מייל, רושם משימה מתוזמנת (כל 15 דקות),
# ובסוף מריץ בדיקה אמיתית ובדיקת תקלה מדומה.
# אפשר גם בלי שאלות, למשל:
#   install.ps1 -MailMethod outlook -To me@example.com -ConfigFile my-jobs.json -Unattended
param(
  [ValidateSet('', 'outlook', 'smtp')][string]$MailMethod = '',
  [string]$To = '', [string]$SmtpServer = '', [int]$SmtpPort = 0, [string]$SmtpUser = '',
  [string]$ConfigFile = '',
  [switch]$Unattended
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$PKG = $PSScriptRoot
# לא ב-AppData: כשמריצים את ההתקנה מתוך אפליקציה של Claude, קבצים ב-AppData נכתבים לעותק פרטי
# של האפליקציה, והמשימה המתוזמנת לא רואה אותם.
$DEST = Join-Path $env:USERPROFILE 'job-watchdog'
$ok = $true
function Check($name, [scriptblock]$test, $fix) {
  try { $r = & $test } catch { $r = $false }
  if ($r) { Write-Host "  [V] $name" -ForegroundColor Green } else { Write-Host "  [X] $name" -ForegroundColor Red; Write-Host "      מה לעשות: $fix" -ForegroundColor Yellow; $script:ok = $false }
}
function Stop-Install($msg) { Write-Host "`n$msg" -ForegroundColor Red; exit 1 }
function Ask($q, $default = '') {
  if ($Unattended) { return $default }
  $d = ''; if ($default) { $d = " [$default]" }
  $a = (Read-Host "   $q$d").Trim()
  if (-not $a) { return $default }; return $a
}

Write-Host "`n=== התקנת שומר המשימות (job-watchdog) ===`n"

# --- 1. בדיקות ---
Write-Host "1. בדיקות לפני ההתקנה:"
Check "PowerShell 5 ומעלה" { $PSVersionTable.PSVersion.Major -ge 5 } "לעדכן את Windows (PowerShell 5.1 מגיע עם Windows 10/11)"
Check "גישה ל-Task Scheduler" { $null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) } "חסר רכיב ה-ScheduledTasks של Windows - לא אמור לקרות ב-Windows 10/11"
if (-not $ok) { Stop-Install 'חסרות דרישות - ההתקנה נעצרה.' }

# --- 2. העתקה ---
Write-Host "`n2. העתקה אל $DEST"
New-Item -ItemType Directory -Force $DEST | Out-Null
foreach ($f in 'common.ps1', 'watchdog.ps1', 'README.md', 'config.example.json') { Copy-Item (Join-Path $PKG $f) (Join-Path $DEST $f) -Force }
. (Join-Path $DEST 'common.ps1')
$cfg = Get-JwConfig
if ($ConfigFile) {
  $j = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($p in $j.PSObject.Properties) {
    if ($p.Name -eq 'Mail') { foreach ($m in $p.Value.PSObject.Properties) { if ($m.Value) { $cfg.Mail[$m.Name] = $m.Value } } }
    elseif ($p.Name -eq 'Jobs') { $cfg.Jobs = @($p.Value) }
    elseif ($p.Name -notlike '_*') { $cfg[$p.Name] = $p.Value }
  }
  Write-Host "  [V] נטענו הגדרות מ-$ConfigFile" -ForegroundColor Green
}

# --- 3. משימות במעקב ---
Write-Host "`n3. משימות במעקב:"
$pick = $true
if (@($cfg.Jobs).Count -gt 0) {
  foreach ($jb in $cfg.Jobs) { Write-Host "   - $($jb.Name)" }
  $pick = (Ask 'לבחור מחדש את רשימת המשימות? (y/n)' 'n') -eq 'y'
}
if ($pick -and -not $Unattended) {
  $cands = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' -and $_.TaskName -ne $JW_TASK } | Sort-Object TaskPath, TaskName)
  if ($cands.Count -eq 0) { Stop-Install 'לא נמצאו משימות מתוזמנות במחשב (חוץ משל Windows). קודם צריך משימה שיש על מה לשמור.' }
  Write-Host "   המשימות המתוזמנות במחשב (בלי של Windows):"
  for ($i = 0; $i -lt $cands.Count; $i++) {
    $inf = $cands[$i] | Get-ScheduledTaskInfo
    $last = 'עוד לא רצה'; if ($inf.LastRunTime -and $inf.LastRunTime.Year -ge 2000) { $last = 'רצה לאחרונה ' + (Format-JwTime $inf.LastRunTime) }
    $full = $cands[$i].TaskName; if ($cands[$i].TaskPath -ne '\') { $full = $cands[$i].TaskPath + $cands[$i].TaskName }
    Write-Host ("   {0,2}. {1}  ({2})" -f ($i + 1), $full, $last)
  }
  $nums = Ask 'מספרי המשימות לשמירה, מופרדים בפסיק (למשל 1,3)'
  $jobs = @()
  foreach ($n in ($nums -split '[,\s]+' | Where-Object { $_ -match '^\d+$' })) {
    $t = $cands[[int]$n - 1]; if (-not $t) { continue }
    $full = $t.TaskName; if ($t.TaskPath -ne '\') { $full = $t.TaskPath + $t.TaskName }
    Write-Host "`n   משימה: $full"
    $job = [ordered]@{ Name = (Ask 'שם ידידותי למייל' $t.TaskName); Task = $full }
    $max = Get-JwDefaultMaxHours $t
    if ($max -gt 0) { Write-Host "   לפי התזמון שלה, היא אמורה לרוץ לפחות כל $max שעות (כולל מרווח ביטחון)." }
    $max = Ask 'כל כמה שעות לכל היותר היא אמורה לרוץ (0 = לא לבדוק)' "$max"
    $job.MaxHoursSinceRun = [double]$max
    $sf = Ask 'יש לה קובץ מצב שהיא כותבת בסוף ריצה? נתיב מלא (Enter = אין)'
    if ($sf) {
      $job.StatusFile = $sf.Trim('"')
      $st = Ask 'איזו מילה בקובץ אומרת שהריצה הצליחה? (Enter = רק לבדוק שהקובץ מתעדכן)'
      if ($st) { $job.SuccessText = $st }
    }
    $jobs += [pscustomobject]$job
  }
  if ($jobs.Count -eq 0) { Stop-Install 'לא נבחרה אף משימה. להריץ שוב ולבחור לפחות אחת.' }
  $cfg.Jobs = $jobs
}
if (@($cfg.Jobs).Count -eq 0) { Stop-Install 'אין משימות במעקב. להריץ את ההתקנה בלי -Unattended, או לתת -ConfigFile.' }
foreach ($jb in $cfg.Jobs) {
  $r = Test-JwJob $jb
  if ($r.Ok) { Write-Host "  [V] $($jb.Name) - תקינה עכשיו (ריצה אחרונה $(Format-JwTime $r.LastRun))" -ForegroundColor Green }
  else { Write-Host "  [!] $($jb.Name) - כבר עכשיו יש בעיה: $($r.Problems -join '; ')" -ForegroundColor Yellow; Write-Host "      השומר ישלח עליה מייל אם היא תימשך." -ForegroundColor Yellow }
}
Save-JwConfig $cfg

# --- 4. מייל ---
Write-Host "`n4. הגדרת מייל:"
if ($MailMethod) { $cfg.Mail.Method = $MailMethod }
if ($To) { $cfg.Mail.To = $To }
if ($SmtpServer) { $cfg.Mail.SmtpServer = $SmtpServer }
if ($SmtpPort) { $cfg.Mail.SmtpPort = $SmtpPort }
if ($SmtpUser) { $cfg.Mail.SmtpUser = $SmtpUser }
if (-not $cfg.Mail.Method) {
  Write-Host "   איך לשלוח את המיילים?"
  Write-Host "   1. דרך Outlook שמותקן במחשב הזה (Outlook הקלאסי, בלי סיסמה)"
  Write-Host "   2. דרך Gmail (צריך סיסמת אפליקציה של Google)"
  Write-Host "   3. דרך שרת SMTP אחר"
  $c = Ask 'לבחור 1 / 2 / 3' '1'
  if ($c -eq '1') { $cfg.Mail.Method = 'outlook' } else { $cfg.Mail.Method = 'smtp' }
  if ($c -eq '2') { $cfg.Mail.SmtpServer = 'smtp.gmail.com'; $cfg.Mail.SmtpPort = 587 }
  if ($c -eq '3') { $cfg.Mail.SmtpServer = Ask 'כתובת שרת ה-SMTP'; $cfg.Mail.SmtpPort = [int](Ask 'פורט' '587') }
}
if (-not $cfg.Mail.To) { $cfg.Mail.To = Ask 'לאיזו כתובת לשלוח (אפשר כמה, מופרדות ב-;)' }
if (-not $cfg.Mail.To) { Stop-Install 'לא הוגדרה כתובת מייל.' }
if ($cfg.Mail.Method -eq 'outlook') {
  Check "Outlook הקלאסי מותקן (לשליחת מייל)" { $null -ne (New-Object -ComObject Outlook.Application) } "להתקין את Outlook הקלאסי, או להריץ שוב את ההתקנה ולבחור Gmail / SMTP (למחוק קודם את $JW_CONFIG)"
} else {
  if (-not $cfg.Mail.SmtpUser) { $cfg.Mail.SmtpUser = Ask 'כתובת המייל שממנה שולחים (שם המשתמש ב-SMTP)' }
  if (-not (Test-Path $JW_SECRET)) {
    if ($Unattended) { Stop-Install 'במצב בלי שאלות אי אפשר לקלוט סיסמה. להריץ את ההתקנה רגיל.' }
    Write-Host "   הסיסמה לא מוקלדת כאן ולא מוצגת: להעתיק אותה (Ctrl+C) ואז ללחוץ Enter."
    if ($cfg.Mail.SmtpServer -eq 'smtp.gmail.com') { Write-Host "   ב-Gmail זו סיסמת אפליקציה (16 תווים) מ: myaccount.google.com/apppasswords" }
    Read-Host "   העתקתי - Enter" | Out-Null
    $sec = $null
    try { $sec = (Get-Clipboard -Raw) } catch { Add-Type -AssemblyName System.Windows.Forms; $sec = [Windows.Forms.Clipboard]::GetText() }
    if (-not $sec -or $sec.Trim().Length -lt 8) { Stop-Install 'בלוח לא נמצאה סיסמה באורך סביר. להעתיק שוב ולהריץ את ההתקנה שוב.' }
    Save-JwSecret ($sec.Trim() -replace '\s', '')
    try { Set-Clipboard -Value ' ' } catch {}
    Write-Host "   [V] הסיסמה נשמרה מוצפנת ב-$JW_SECRET (רק המשתמש שלך במחשב הזה יכול לפתוח אותה). הלוח נוקה." -ForegroundColor Green
  }
}
Save-JwConfig $cfg
$sent = Send-JwMail $cfg 'שומר המשימות: מייל בדיקה מההתקנה' ("זה מייל בדיקה מהתקנת שומר המשימות. אם הגיע - שליחת המייל עובדת.<br>משימות במעקב: " + (($cfg.Jobs | ForEach-Object { ConvertTo-JwHtml $_.Name }) -join ', '))
if ($sent) { Write-Host "  [V] נשלח מייל בדיקה אל $($cfg.Mail.To) - לבדוק שהגיע (גם בספאם)" -ForegroundColor Green }
else { $ok = $false; Write-Host "  [X] שליחת המייל נכשלה. הסיבה בסוף $JW_LOGS\watchdog.log. בלי מייל השומר לא יוכל להתריע." -ForegroundColor Red }

# --- 5. משימה מתוזמנת ---
Write-Host "`n5. רישום משימה מתוזמנת '$JW_TASK' (כל 15 דקות, כשהמשתמש מחובר):"
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$DEST\watchdog.ps1`""
# conhost --headless מריץ בלי חלון שקופץ כל 15 דקות (Windows 10 מ-2021 ו-Windows 11)
$conhost = "$env:WINDIR\System32\conhost.exe"
if ([Environment]::OSVersion.Version.Build -ge 19044 -and (Test-Path $conhost)) { $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$ps`" $psArgs" -WorkingDirectory $DEST }
else { $action = New-ScheduledTaskAction -Execute $ps -Argument "-WindowStyle Hidden $psArgs" -WorkingDirectory $DEST }
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $JW_TASK -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "שומר המשימות: בודק שהמשימות במעקב רצו והצליחו ושולח מייל. קבצים: $DEST" -Force | Out-Null
Check "המשימה רשומה" { $null -ne (Get-ScheduledTask -TaskName $JW_TASK -ErrorAction SilentlyContinue) } "רישום המשימה נכשל. לשלוח צילום מסך של החלון הזה."

# --- 6. בדיקות אחרי ---
Write-Host "`n6. בדיקות אחרי ההתקנה:"
$hb = Join-Path $DEST 'heartbeat.txt'
$t0 = Get-Date
Start-ScheduledTask -TaskName $JW_TASK
$ran = $false
for ($i = 0; $i -lt 45 -and -not $ran; $i++) { Start-Sleep 2; $ran = (Test-Path $hb) -and ((Get-Item $hb).LastWriteTime -gt $t0) }
Check "ריצה אמיתית של השומר דרך Task Scheduler" { $ran } "השומר לא רץ. לשלוח את $JW_LOGS\watchdog.log."
if ($ran) { Write-Host "      $(Get-Content $hb -Encoding UTF8)" }

Write-Host "`n   בדיקת תקלה מדומה: משימה שלא קיימת, כדי לראות שהשומר מזהה ומתריע..."
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DEST 'watchdog.ps1') -Test
$lines = Get-Content (Join-Path $JW_LOGS 'watchdog.log') -Encoding UTF8 | Select-Object -Last 4
$lines | ForEach-Object { Write-Host "      $_" }
Check "השומר זיהה את התקלה המדומה" { ($lines -join ' ') -match '\[בדיקה\] משימה מדומה לבדיקה - תקלה' } "לשלוח את $JW_LOGS\watchdog.log."
if ($sent) { Write-Host "      אמור להגיע מייל שמתחיל ב-[בדיקה] - זה תקין, זו בדיקה." }

if ($ok) { Write-Host "`nההתקנה הושלמה. השומר רץ כל 15 דקות, ומחר בבוקר יגיע מייל 'שומר המשימות: הכל תקין'.`nהגדרות: $JW_CONFIG`nיומן: $JW_LOGS\watchdog.log" -ForegroundColor Green }
else { Write-Host "`nההתקנה הסתיימה עם בעיות (מסומנות ב-X למעלה)." -ForegroundColor Red; exit 1 }
