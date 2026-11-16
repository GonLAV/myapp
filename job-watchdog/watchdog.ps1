# שומר המשימות המתוזמנות. רץ כל 15 דקות כמשימה מתוזמנת (job-watchdog) של המשתמש.
# לכל משימה במעקב: בודק שרצה בזמן והצליחה. בעיה ← בודק שוב בריצות הבאות, ורק אם היא נמשכת
# ConfirmMinutes מכריז על תקלה ושולח מייל. תזכורת לכל היותר פעם ב-RepeatAlertHours. מייל "חי" כל בוקר.
# רק ניטור ודיווח: לא מריץ, לא עוצר ולא משנה שום משימה.
# -Test: מוסיף משימה מדומה שנכשלת תמיד, ושולח עליה מייל [בדיקה] (בלי לגעת במצב של המשימות האמיתיות).
# -MorningNow: שולח עכשיו את מייל הבוקר (לבדיקה).
param([switch]$Test, [switch]$MorningNow)
. (Join-Path $PSScriptRoot 'common.ps1')

$mutex = New-Object Threading.Mutex($false, $(if ($Test) { 'Local\job-watchdog-test' } else { 'Local\job-watchdog' }))
if (-not $mutex.WaitOne(0)) { exit 0 }

function ConvertTo-Hash($o) {
  if ($o -is [Management.Automation.PSCustomObject]) { $h = [ordered]@{}; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hash $p.Value }; return $h }
  return $o
}

$cfg = Get-JwConfig
$state = [ordered]@{ Day = ''; Checks = 0; Incidents = [ordered]@{}; PrevDay = $null; LastMorningDate = ''; Jobs = [ordered]@{} }
if (Test-Path $JW_STATE) { $s = ConvertTo-Hash (Get-Content $JW_STATE -Raw -Encoding UTF8 | ConvertFrom-Json); foreach ($k in @($s.Keys)) { $state[$k] = $s[$k] } }
foreach ($k in 'Incidents', 'Jobs') { if (-not $state[$k]) { $state[$k] = [ordered]@{} } }
function Save-State { if (-not $Test) { $state | ConvertTo-Json -Depth 6 | Set-Content $JW_STATE -Encoding UTF8 } }

$now = Get-Date
$today = $now.ToString('yyyy-MM-dd')
$tag = ''; if ($Test) { $tag = '[בדיקה] ' }

if ($state.Day -ne $today) {
  if ($state.Day) {
    $state.PrevDay = [ordered]@{ Day = $state.Day; Checks = $state.Checks; Incidents = $state.Incidents }
    Write-JwLog ("סיכום {0}: {1} ריצות של השומר, תקלות: {2}" -f $state.Day, $state.Checks, (($state.Incidents.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '))
  }
  $state.Day = $today; $state.Checks = 0; $state.Incidents = [ordered]@{}
}
if (-not $Test) { $state.Checks++ }

$jobs = @($cfg.Jobs)
if ($Test) { $jobs = @([pscustomobject]@{ Name = 'משימה מדומה לבדיקה'; Task = 'job-watchdog-test-no-such-task'; MaxHoursSinceRun = 26 }) }
if ($jobs.Count -eq 0) { Write-JwLog 'אין משימות במעקב ב-config.json' }

$results = @()
foreach ($job in $jobs) {
  $name = "$($job.Name)"; if (-not $name) { $name = "$($job.Task)" }
  $r = Test-JwJob $job
  if (-not $r.Ok) {
    # בדיקה חוזרת מיד, למקרה שהמשימה בדיוק באמצע כתיבה או סיום
    Start-Sleep -Seconds 10
    $r = Test-JwJob $job
  }
  $js = $state.Jobs[$name]; if (-not $js -or $Test) { $js = [ordered]@{ Status = 'ok'; FirstBadAt = ''; LastAlert = ''; Problem = '' } }
  $problem = ($r.Problems -join '; ')

  if ($r.Ok) {
    if ($js.Status -eq 'down') {
      Write-JwLog "$name - חזרה לעבוד"
      Send-JwMail $cfg "✅ שומר המשימות: '$name' חזרה לעבוד" ("המשימה <b>{0}</b> הייתה בתקלה מ-{1} ועכשיו תקינה.<br>ריצה אחרונה: {2}" -f (ConvertTo-JwHtml $name), (Format-JwTime ([datetime]$js.FirstBadAt)), (Format-JwTime $r.LastRun)) | Out-Null
    } elseif ($js.Status -eq 'suspect') { Write-JwLog "$name - הבעיה נעלמה לפני שהוכרזה תקלה (היה: $($js.Problem))" }
    $js.Status = 'ok'; $js.FirstBadAt = ''; $js.LastAlert = ''; $js.Problem = ''
  } else {
    if ($js.Status -eq 'ok') { $js.Status = 'suspect'; $js.FirstBadAt = $now.ToString('o') }
    $js.Problem = $problem
    $since = [datetime]$js.FirstBadAt
    $confirmed = $Test -or (($now - $since).TotalMinutes -ge [double]$cfg.ConfirmMinutes)
    if (-not $confirmed) { Write-JwLog "$name - חשד לבעיה, אבדוק שוב בריצות הבאות: $problem" }
    else {
      if ($js.Status -ne 'down') { $js.Status = 'down'; if (-not $Test) { $state.Incidents[$name] = 1 + [int]$state.Incidents[$name] } }
      Write-JwLog "${tag}$name - תקלה: $problem"
      $repeat = [math]::Max(1, [double]$cfg.RepeatAlertHours)
      $due = (-not $js.LastAlert) -or (($now - [datetime]$js.LastAlert).TotalHours -ge $repeat)
      if ($due) {
        $taskLine = ''
        if ($job.Task) { $taskLine = "<li>לפתוח את <b>Task Scheduler</b> (Win+R ← taskschd.msc), למצוא את <b dir='ltr'>$(ConvertTo-JwHtml $job.Task)</b>, ולבדוק את הלשונית <b>History</b> או ללחוץ <b>Run</b> כדי להריץ ידנית.</li>" }
        $fileLine = ''
        if ($job.StatusFile) { $fileLine = "<li>לפתוח את קובץ המצב: <span dir='ltr'>$(ConvertTo-JwHtml ([Environment]::ExpandEnvironmentVariables($job.StatusFile)))</span></li>" }
        $items = ($r.Problems | ForEach-Object { "<li>$(ConvertTo-JwHtml $_)</li>" }) -join ''
        $again = ''; if ($js.LastAlert) { $again = ' (תזכורת)' }
        $body = "המשימה <b>$(ConvertTo-JwHtml $name)</b> לא תקינה מאז <b>$(Format-JwTime $since)</b>$again.<ul>$items</ul>ריצה אחרונה: $(Format-JwTime $r.LastRun)<br><br><b>מה לעשות:</b><ol>$taskLine$fileLine<li>אם לא ברור מה קרה - להעביר את המייל הזה לסוכן שבנה את המשימה.</li></ol>אם לא יהיה שינוי, תגיע תזכורת בעוד $repeat שעות. כשהמשימה תחזור לעבוד יגיע מייל."
        if (Send-JwMail $cfg "${tag}⚠️ שומר המשימות: '$name' - צריך טיפול" $body) { $js.LastAlert = $now.ToString('o') }
      }
    }
  }
  if (-not $Test) { $state.Jobs[$name] = $js }
  $results += [pscustomobject]@{ Name = $name; Ok = $r.Ok; Status = $js.Status; Problem = $problem; LastRun = $r.LastRun }
}

$bad = @($results | Where-Object { -not $_.Ok }).Count
if (-not $Test) {
  Set-Content (Join-Path $JW_HOME 'heartbeat.txt') ("ריצה אחרונה: {0:yyyy-MM-dd HH:mm:ss} - {1} משימות במעקב, {2} עם בעיה" -f (Get-Date), $results.Count, $bad) -Encoding UTF8
  Write-JwLog ("ריצה: {0} משימות, {1} עם בעיה" -f $results.Count, $bad)
}

# --- מייל בוקר: פעם ביום, גם כשהכל תקין, כדי שיהיה ברור שהשומר עצמו חי ---
if (-not $Test -and ($MorningNow -or ($state.LastMorningDate -ne $today -and $now.Hour -ge [int]$cfg.MorningHour))) {
  $prev = $state.PrevDay
  $rows = foreach ($x in $results) {
    $st = switch ($x.Status) { 'ok' { '<span style="color:#15803d">תקינה</span>' } 'suspect' { '<span style="color:#b45309">בבדיקה חוזרת</span>' } default { '<span style="color:#b91c1c"><b>בתקלה</b></span>' } }
    $y = ''; if ($prev -and $prev.Incidents -and $prev.Incidents[$x.Name]) { $y = 'הייתה תקלה' }
    "<tr><td style='padding:6px;border-bottom:1px solid #eee'>$(ConvertTo-JwHtml $x.Name)</td><td style='padding:6px;border-bottom:1px solid #eee'>$st</td><td style='padding:6px;border-bottom:1px solid #eee'>$(Format-JwTime $x.LastRun)</td><td style='padding:6px;border-bottom:1px solid #eee'>$y</td></tr>"
  }
  $table = "<table cellpadding='0' cellspacing='0' style='border-collapse:collapse;font-size:14px'><tr style='background:#f4f4f4'><th align='right' style='padding:6px'>משימה</th><th align='right' style='padding:6px'>מצב עכשיו</th><th align='right' style='padding:6px'>ריצה אחרונה</th><th align='right' style='padding:6px'>אתמול</th></tr>$($rows -join '')</table>"
  $yesterday = ''
  if ($prev) { $yesterday = ("<br>אתמול ({0}) השומר בדק {1} פעמים, ונמצאו {2} תקלות." -f $prev.Day, $prev.Checks, @($prev.Incidents.Keys).Count) }
  if ($bad -eq 0) { $subject = "שומר המשימות: הכל תקין ($($results.Count) משימות)" } else { $subject = "שומר המשימות: $bad משימות עם בעיה" }
  $body = "השומר חי ובודק כל 15 דקות.$yesterday<br><br>$table<br>מייל כזה מגיע כל בוקר. לא הגיע? כנראה שהשומר עצמו לא רץ (המחשב כבוי, או שהמשימה job-watchdog כבויה)."
  if (Send-JwMail $cfg $subject $body) { $state.LastMorningDate = $today }
}

Save-State
$mutex.ReleaseMutex()
# קוד 0 גם כשמשימה במעקב בתקלה: ב-Task Scheduler כישלון של השומר צריך לסמן רק תקלה בשומר עצמו.
exit 0
