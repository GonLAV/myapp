# פונקציות משותפות לשומר ולמתקין: הגדרות, יומן, בדיקת משימה, מייל.
$ErrorActionPreference = 'Stop'
$JW_HOME = $PSScriptRoot
$JW_CONFIG = Join-Path $JW_HOME 'config.json'
$JW_STATE = Join-Path $JW_HOME 'state.json'
$JW_SECRET = Join-Path $JW_HOME 'mail-secret.bin'
$JW_LOGS = Join-Path $JW_HOME 'logs'
$JW_TASK = 'job-watchdog'

function Get-JwConfig {
  $cfg = [ordered]@{
    MorningHour = 8          # מייל "חי" יומי, בריצה הראשונה מהשעה הזו
    ConfirmMinutes = 30      # כמה זמן בעיה צריכה להימשך עד שמכריזים על תקלה
    RepeatAlertHours = 24    # תזכורת על אותה תקלה לכל היותר פעם בכך שעות (מינימום 1)
    Mail = [ordered]@{ Method = ''; To = ''; SmtpServer = 'smtp.gmail.com'; SmtpPort = 587; SmtpUser = '' }
    Jobs = @()
  }
  if (Test-Path $JW_CONFIG) {
    $j = Get-Content $JW_CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $j.PSObject.Properties) {
      if ($p.Name -eq 'Mail') { foreach ($m in $p.Value.PSObject.Properties) { $cfg.Mail[$m.Name] = $m.Value } }
      elseif ($p.Name -eq 'Jobs') { $cfg.Jobs = @($p.Value | Where-Object { $_ }) }
      else { $cfg[$p.Name] = $p.Value }
    }
  }
  return $cfg
}

function Save-JwConfig($cfg) {
  $cfg | ConvertTo-Json -Depth 6 | Set-Content $JW_CONFIG -Encoding UTF8
}

function Write-JwLog([string]$msg) {
  New-Item -ItemType Directory -Force $JW_LOGS | Out-Null
  $f = Join-Path $JW_LOGS 'watchdog.log'
  if ((Test-Path $f) -and (Get-Item $f).Length -gt 1MB) { Move-Item $f (Join-Path $JW_LOGS 'watchdog.old.log') -Force }
  Add-Content $f ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg) -Encoding UTF8
}

function Get-JwTask([string]$name) {
  $path = '\'; $leaf = $name
  if ($name -match '^(\\.*\\)([^\\]+)$') { $path = $Matches[1]; $leaf = $Matches[2] }
  return Get-ScheduledTask -TaskPath $path -TaskName $leaf -ErrorAction SilentlyContinue
}

# כל כמה שעות המשימה אמורה לרוץ, לפי הטריגרים שלה. 0 = לא ידוע (למשל רק בהפעלת המחשב).
function Get-JwTaskIntervalHours($task) {
  $best = 0
  foreach ($t in @($task.Triggers)) {
    $h = 0
    $cls = $t.CimClass.CimClassName
    if ($t.Repetition -and $t.Repetition.Interval) { try { $h = ([Xml.XmlConvert]::ToTimeSpan($t.Repetition.Interval)).TotalHours } catch {} }
    elseif ($cls -eq 'MSFT_TaskDailyTrigger') { $h = 24 * [math]::Max(1, [int]$t.DaysInterval) }
    elseif ($cls -eq 'MSFT_TaskWeeklyTrigger') { $h = 168 * [math]::Max(1, [int]$t.WeeksInterval) }
    if ($h -gt 0 -and ($best -eq 0 -or $h -lt $best)) { $best = $h }
  }
  return $best
}

# מרווח ביטחון: המחשב יכול להיות כבוי בזמן הריצה, והמשימה רצה כשהוא נדלק.
function Get-JwDefaultMaxHours($task) {
  $h = Get-JwTaskIntervalHours $task
  if ($h -le 0) { return 0 }
  return [math]::Round($h * 1.1 + 2, 1)
}

function Format-JwTime($t) { if (-not $t) { return 'אף פעם' }; return ('{0:dd-MM-yyyy HH:mm}' -f $t) }

# בודק משימה אחת. מחזיר Ok, Problems (רשימת בעיות בעברית) ו-LastRun (תיאור הריצה האחרונה).
function Test-JwJob($job) {
  $now = Get-Date
  $problems = @()
  $lastRun = $null
  $max = 0; if ($job.MaxHoursSinceRun) { $max = [double]$job.MaxHoursSinceRun }

  if ($job.Task) {
    $t = Get-JwTask $job.Task
    if (-not $t) { $problems += "המשימה '$($job.Task)' לא קיימת ב-Task Scheduler (נמחקה או שונה שמה)" }
    else {
      $i = $t | Get-ScheduledTaskInfo
      $code = [int64]$i.LastTaskResult
      $ran = $i.LastRunTime; if ($ran -and $ran.Year -lt 2000) { $ran = $null }
      $lastRun = $ran
      if ($t.State -eq 'Disabled') { $problems += 'המשימה כבויה ב-Task Scheduler (Disabled)' }
      elseif ($t.State -ne 'Running') {
        # 267009 = רצה עכשיו, 267011 = עוד לא רצה, 267014 = נעצרה ידנית
        if (-not $ran) { $problems += 'המשימה עוד לא רצה אף פעם' }
        elseif ($code -ne 0 -and $code -ne 267009) {
          $hex = '0x{0:X}' -f $code
          $why = switch ($code) { 267014 { ' - נעצרה ידנית' } 2147942402 { ' - קובץ לא נמצא' } 2147942667 { ' - תיקיית העבודה לא נמצאה' } 1 { ' - התוכנית החזירה שגיאה' } default { '' } }
          $problems += "הריצה האחרונה ($(Format-JwTime $ran)) נכשלה: קוד $code ($hex)$why"
        }
        if ($ran -and $max -gt 0 -and ($now - $ran).TotalHours -gt $max) { $problems += "המשימה לא רצה מאז $(Format-JwTime $ran) (מצופה לפחות כל $max שעות)" }
      }
    }
  }

  if ($job.StatusFile) {
    $f = [Environment]::ExpandEnvironmentVariables($job.StatusFile)
    if (-not (Test-Path $f)) { $problems += "קובץ המצב לא נמצא: $f" }
    else {
      $w = (Get-Item $f).LastWriteTime
      if (-not $lastRun -or $w -gt $lastRun) { $lastRun = $w }
      $text = ''
      try { $text = (Get-Content $f -Raw -Encoding UTF8) } catch {}
      $first = (("$text" -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
      if ($max -gt 0 -and ($now - $w).TotalHours -gt $max) { $problems += "קובץ המצב לא התעדכן מאז $(Format-JwTime $w) (מצופה לפחות כל $max שעות)" }
      if ($job.FailText -and "$text" -match [regex]::Escape($job.FailText)) { $problems += "קובץ המצב מראה כישלון: $first" }
      elseif ($job.SuccessText -and "$text" -notmatch [regex]::Escape($job.SuccessText)) { $problems += "קובץ המצב לא מראה הצלחה: $first" }
    }
  }

  if (-not $job.Task -and -not $job.StatusFile) { $problems += 'בהגדרות המשימה אין Task ואין StatusFile - אין מה לבדוק' }
  return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems; LastRun = $lastRun }
}

# --- מייל: Outlook שבמחשב (בלי סיסמה) או SMTP (למשל Gmail עם סיסמת אפליקציה) ---
function Save-JwSecret([string]$secret) {
  Add-Type -AssemblyName System.Security
  $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($secret), $null, 'CurrentUser')
  [IO.File]::WriteAllBytes($JW_SECRET, $bytes)
}

function Get-JwSecret {
  if (-not (Test-Path $JW_SECRET)) { return $null }
  Add-Type -AssemblyName System.Security
  $b = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($JW_SECRET), $null, 'CurrentUser')
  return [Text.Encoding]::UTF8.GetString($b)
}

function Test-JwMailReady($cfg) {
  if (-not $cfg.Mail.To) { return $false }
  if ($cfg.Mail.Method -eq 'outlook') { return $true }
  if ($cfg.Mail.Method -eq 'smtp') { return ($cfg.Mail.SmtpServer -and $cfg.Mail.SmtpUser -and (Test-Path $JW_SECRET)) }
  return $false
}

function Send-JwMail($cfg, [string]$subject, [string]$htmlBody) {
  if (-not (Test-JwMailReady $cfg)) { Write-JwLog "מייל לא מוגדר - לא נשלח: $subject"; return $false }
  $html = "<html><body><div dir='rtl' style='font-family:Arial,sans-serif;font-size:14px;line-height:1.5'>$htmlBody<p style='color:#888;font-size:12px;margin-top:20px'>הודעה אוטומטית משומר המשימות (job-watchdog) במחשב $env:COMPUTERNAME.</p></div></body></html>"
  try {
    if ($cfg.Mail.Method -eq 'outlook') {
      $o = New-Object -ComObject Outlook.Application
      $m = $o.CreateItem(0)
      $m.To = $cfg.Mail.To; $m.Subject = $subject; $m.HTMLBody = $html
      $m.Send()
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $msg = New-Object Net.Mail.MailMessage
      $msg.From = $cfg.Mail.SmtpUser
      foreach ($a in ($cfg.Mail.To -split '[;,]')) { if ($a.Trim()) { $msg.To.Add($a.Trim()) } }
      $msg.Subject = $subject; $msg.Body = $html; $msg.IsBodyHtml = $true
      $msg.SubjectEncoding = [Text.Encoding]::UTF8; $msg.BodyEncoding = [Text.Encoding]::UTF8
      $c = New-Object Net.Mail.SmtpClient($cfg.Mail.SmtpServer, [int]$cfg.Mail.SmtpPort)
      $c.EnableSsl = $true
      $c.Credentials = New-Object Net.NetworkCredential($cfg.Mail.SmtpUser, (Get-JwSecret))
      $c.Send($msg); $msg.Dispose(); $c.Dispose()
    }
    Write-JwLog "מייל נשלח: $subject"
    return $true
  } catch {
    Write-JwLog ("שליחת מייל נכשלה: " + $_.Exception.Message)
    return $false
  }
}

function ConvertTo-JwHtml([string]$text) {
  return [Net.WebUtility]::HtmlEncode($text) -replace "`r?`n", '<br>'
}
