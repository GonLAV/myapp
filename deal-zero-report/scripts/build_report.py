"""Zero report for one deal: fill the Excel template, cross-check, build two PDFs.

Usage: python build_report.py deal.json
Nothing reaches output_dir unless Excel and the independent model agree to the shekel.
Exit codes: 0 done, 2 input problem, 3 cross-check failed.
"""
import base64, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, '..', 'assets', 'zero-report-template.xlsx')
LOGO = os.path.join(HERE, '..', 'assets', 'logo-horizontal.png')
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
MAX_ROWS = 10
VAT = 1.18


def die(code, msg):
    print('ERROR: ' + msg)
    sys.exit(code)


def ps_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def load(path):
    d = json.load(open(path, encoding='utf-8'))
    for k in ('name', 'short', 'date', 'plot_m2', 'asking_per_m2', 'sale_per_m2', 'purchase_tax_pct', 'units', 'basement_m2', 'parking_m2', 'output_dir'):
        if d.get(k) in (None, '', []):
            die(2, f'missing field: {k}')
    if len(d['units']) > MAX_ROWS:
        die(2, f'{len(d["units"])} unit lines, the template holds {MAX_ROWS}. Group identical units.')
    if sum(1 for u in d['units'] if u.get('fixed_price')) > 1:
        die(2, 'only one unit can have a fixed price')
    d.setdefault('brokerage_pct', 1)
    d.setdefault('land_rate_pct', 6.5)
    d.setdefault('target_margin_pct', 16)
    d.setdefault('basis', [])
    d.setdefault('open_items', [])
    return d


# Independent of Excel on purpose: this is what the workbook gets compared against
def model(d, land, fixed, sale=1.0, build=1.0, years=2, indirect30=False):
    area = sum(u['m2'] * u['qty'] for u in d['units'])
    outdoor = sum(u.get('outdoor_m2', 0) * u['qty'] for u in d['units'])
    units = sum(u['qty'] for u in d['units'])
    base = d.get('base_m2') or area
    gross = 0.0
    for u in d['units']:
        if fixed and u.get('fixed_price'):
            gross += u['fixed_price'] * u['qty']
        else:
            gross += d['sale_per_m2'] * sale * (u['m2'] + u.get('outdoor_m2', 0) / 2) * u['qty']
    net = gross / VAT
    built = area * 1.2
    plot = d['plot_m2']
    L = base * land
    brok = L * d['brokerage_pct'] / 100
    tax = L * d['purchase_tax_pct'] / 100
    soft = plot * 11 + 40000 * units + 25000 * units + built * 300
    direct = (d['basement_m2'] * 6000 + built * 10000 + d['parking_m2'] * 6000) * build + outdoor * 2000 + plot * 250
    bzm = (.30 if indirect30 else .05) * direct
    mkt = .02 * gross
    over = 0 if indirect30 else .05 * (built * 10000 * build + outdoor * 2000 + plot * 250)
    legal = .005 * L
    non = L + brok + tax + soft + direct + bzm + mkt + over + legal
    fin = d['land_rate_pct'] / 100 * (L + brok) * years / 2 + .0075 * non + .0035 * net * years + .01 * net * years + .003 * net + 120000 + 7500 + (years * 12 * 4500 + 20000)
    cost = non + fin
    return dict(gross=gross, net=net, L=L, brok=brok, tax=tax, soft=soft, direct=direct, bzm=bzm, mkt=mkt, over=over, legal=legal, fin=fin, cost=cost, profit=net - cost, pct=(net - cost) / net)


# Label, model arguments. Set in Excel by the matching block in excel_fill_and_calc
SENSITIVITY = [('sale', 'מחיר מכירה נמוך ב-10%', dict(sale=.9)),
               ('build', 'בנייה יקרה ב-10%', dict(build=1.1)),
               ('years', '3 שנים במקום 2', dict(years=3)),
               ('indirect', 'עלויות עקיפות 30%', dict(indirect30=True))]


def model_solve(d, fixed, target, **kw):
    lo, hi = 0.0, 500000.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if model(d, mid, fixed, **kw)['pct'] > target:
            lo = mid
        else:
            hi = mid
    return lo


def excel_fill_and_calc(d, xlsx, out_json):
    tax, brok, rate = d['purchase_tax_pct'], d['brokerage_pct'], d['land_rate_pct']
    lines = []
    fixed_row = None
    for i, u in enumerate(d['units']):
        row = 8 + i
        lines.append(f"$r.Range('B{row}').Formula={ps_str(u['label'])}; $r.Range('C{row}').Formula='{u['m2']}'; $r.Range('D{row}').Formula='{u.get('outdoor_m2', 0)}'; $r.Range('G{row}').Formula='{u['qty']}'; $r.Range('I{row}').Formula={ps_str(u.get('note', ''))}")
        if u.get('fixed_price'):
            fixed_row = row
    fx = ''
    if fixed_row:
        fx = f"$r.Range('F{fixed_row}').Formula='=IF(הוצאות!$K$23>0,הוצאות!$K$23,E{fixed_row}*(C{fixed_row}+D{fixed_row}/2))'"
    units = sum(u['qty'] for u in d['units'])
    base = f"$x.Range('E16').Formula='{d['base_m2']}'" if d.get('base_m2') else ''
    fixed_price = next((u['fixed_price'] for u in d['units'] if u.get('fixed_price')), 0)
    offer = d.get('offer_per_m2') or 0
    t = d['target_margin_pct'] / 100
    ps = rf'''$ErrorActionPreference='Stop'
$xl = New-Object -ComObject Excel.Application
$xl.Visible=$false; $xl.DisplayAlerts=$false
try {{
  $wb = $xl.Workbooks.Open({ps_str(xlsx)})
  $x=$wb.Worksheets.Item(1); $r=$wb.Worksheets.Item(2); $f=$wb.Worksheets.Item(3)
  $x.Range('D4').Formula={ps_str(d['name'])}; $x.Range('H5').Formula={ps_str(d['date'])}
  $x.Range('D5').Formula='{units}'; $x.Range('D7').Formula='{units}'; $x.Range('D9').Formula='{d['plot_m2']}'
  $x.Range('D42').Formula='{d['sale_per_m2']}'; $x.Range('E24').Formula='{d['basement_m2']}'; $x.Range('E26').Formula='{d['parking_m2']}'
  $x.Range('F16').Formula='{d['asking_per_m2']}'; $x.Range('F17').Formula='={brok}%*E17'; $x.Range('F18').Formula='={tax}%*E18'
  $x.Range('D19').Formula={ps_str(d.get('betterment', 'לא נאמד - חשיפה פתוחה'))}
  $x.Range('K20').Formula='{t}'; $x.Range('K23').Formula='0'
  $f.Range('F9').Formula='{rate / 100}'
  {base}
  {chr(10).join('  ' + l for l in lines)}
  {fx}
  $xl.CalculateFull(); $wb.Save(); $wb.Close($false)

  $wb = $xl.Workbooks.Open({ps_str(xlsx)},0,$true)
  $x=$wb.Worksheets.Item(1); $r=$wb.Worksheets.Item(2)
  $res=@()
  $snap={{ param($tag,$ph,$land)
    $x.Range('K23').Formula=[string]$ph; $x.Range('F16').Formula=[string]$land; $xl.Calculate()
    [ordered]@{{tag=$tag;ph=[double]$ph;land=[double]$land;gross=$r.Range('H18').Value2;net=$r.Range('H19').Value2;L=$x.Range('G16').Value2;brok=$x.Range('G17').Value2;tax=$x.Range('G18').Value2;
      soft=($x.Range('G20').Value2+$x.Range('G21').Value2+$x.Range('G22').Value2+$x.Range('G23').Value2);direct=$x.Range('E29').Value2;bzm=$x.Range('G29').Value2;mkt=$x.Range('G30').Value2;fin=$x.Range('G31').Value2;over=$x.Range('G32').Value2;legal=$x.Range('G33').Value2;
      cost=$x.Range('G34').Value2;profit=$x.Range('K9').Value2;pct=$x.Range('H10').Value2;solve=$x.Range('K22').Value2}}
  }}
  $phs = @(0); if({fixed_price} -gt 0){{ $phs = @(0,{fixed_price}) }}
  foreach($ph in $phs){{
    $res += ,(& $snap 'ask' $ph {d['asking_per_m2']})
    if({offer} -gt 0){{ $res += ,(& $snap 'offer' $ph {offer}) }}
    $s=$x.Range('K22').Value2
    $res += ,(& $snap 'target' $ph $s)
    $x.Range('F16').Formula='{d['asking_per_m2']}'
  }}
  $err=0; foreach($sh in $wb.Worksheets){{ foreach($c in $sh.UsedRange.Cells){{ if($c.Text -like '#*'){{ $err++ }} }} }}
  # Sensitivity runs on the read-only copy, nothing here reaches the saved workbook
  $f=$wb.Worksheets.Item(3)
  $sens=@()
  $apply={{ param($k)
    if($k -eq 'sale'){{ $x.Range('D42').Formula='{d['sale_per_m2'] * .9}' }}
    if($k -eq 'build'){{ $x.Range('F24').Formula='6600'; $x.Range('F25').Formula='11000'; $x.Range('F26').Formula='6600' }}
    if($k -eq 'years'){{ $f.Range('F9').Formula='{rate / 100 * 1.5}'; $f.Range('I11').Formula='=H11*F11*3'; $f.Range('I12').Formula='=H12*F12*3'; $f.Range('I16').Formula='=36*4500+20000' }}
    if($k -eq 'indirect'){{ $x.Range('F29').Formula='0.3'; $x.Range('F32').Formula='0' }}
  }}
  $reset={{
    $x.Range('D42').Formula='{d['sale_per_m2']}'; $x.Range('F24').Formula='6000'; $x.Range('F25').Formula='10000'; $x.Range('F26').Formula='6000'
    $f.Range('F9').Formula='{rate / 100}'; $f.Range('I11').Formula='=H11*F11*2'; $f.Range('I12').Formula='=H12*F12*2'; $f.Range('I16').Formula='=24*4500+20000'
    $x.Range('F29').Formula='0.05'; $x.Range('F32').Formula='0.05'
  }}
  foreach($k in {','.join("'" + s[0] + "'" for s in SENSITIVITY)}){{
    foreach($ph in $phs){{
      & $apply $k
      $x.Range('K23').Formula=[string]$ph; $x.Range('F16').Formula='{d['asking_per_m2']}'; $xl.Calculate()
      $row=[ordered]@{{key=$k;ph=[double]$ph;profit=$x.Range('K9').Value2;pct=$x.Range('H10').Value2;solve=$x.Range('K22').Value2;offer_pct=$null}}
      if({offer} -gt 0){{ $x.Range('F16').Formula='{offer}'; $xl.Calculate(); $row.offer_pct=$x.Range('H10').Value2 }}
      $sens += ,$row
      & $reset
    }}
  }}
  $o=[ordered]@{{rows=$res;sens=$sens;errors=$err;d8=$x.Range('D8').Value2}}
  ($o | ConvertTo-Json -Depth 4) | Out-File -Encoding ascii {ps_str(out_json)}
  $wb.Close($false)
}} finally {{ $xl.Quit() }}
'''
    p = out_json + '.ps1'
    open(p, 'w', encoding='utf-8-sig').write(ps)
    r = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], capture_output=True, timeout=180)
    if r.returncode or not os.path.exists(out_json):
        die(3, 'Excel step failed: ' + r.stderr.decode('cp1255', 'replace')[:600])
    return json.load(open(out_json))


def cross_check(d, xl):
    if xl['errors']:
        die(3, f'{xl["errors"]} error cells in the workbook')
    bad = []
    for r in xl['rows']:
        m = model(d, r['land'], r['ph'] > 0)
        for k in ('gross', 'net', 'L', 'brok', 'tax', 'soft', 'direct', 'fin', 'cost', 'profit'):
            if abs(m[k] - r[k]) > 1:
                bad.append(f'{r["tag"]}/{r["ph"]:.0f} {k}: excel {r[k]:,.2f} model {m[k]:,.2f}')
        if abs(m['pct'] - r['pct']) > 1e-6:
            bad.append(f'{r["tag"]} pct: excel {r["pct"]} model {m["pct"]}')
        if r['tag'] == 'target' and abs(r['pct'] - d['target_margin_pct'] / 100) > 1e-6:
            bad.append(f'target price gives {r["pct"]:.4%}, expected {d["target_margin_pct"]}%')
    args = {k: kw for k, _, kw in SENSITIVITY}
    target = d['target_margin_pct'] / 100
    for s in xl['sens']:
        fixed, kw = s['ph'] > 0, args[s['key']]
        m = model(d, d['asking_per_m2'], fixed, **kw)
        if abs(m['profit'] - s['profit']) > 1:
            bad.append(f'sens {s["key"]}/{s["ph"]:.0f} profit: excel {s["profit"]:,.2f} model {m["profit"]:,.2f}')
        if abs(model_solve(d, fixed, target, **kw) - s['solve']) > .01:
            bad.append(f'sens {s["key"]}/{s["ph"]:.0f} target price: excel {s["solve"]:,.2f}')
        if d.get('offer_per_m2') and abs(model(d, d['offer_per_m2'], fixed, **kw)['pct'] - s['offer_pct']) > 1e-6:
            bad.append(f'sens {s["key"]}/{s["ph"]:.0f} offer pct: excel {s["offer_pct"]}')
    if bad:
        die(3, 'cross-check failed, no files produced:\n' + '\n'.join(bad[:12]))


BASE_CSS = '''
:root{--navy:#21386D;--acc:#8E1F2F;--tint:#EDF0F7;--ink:#1f2733;--muted:#5F6B80;--line:#e3e6eb;--soft:#f4f5f8;--red:#C41C29}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:var(--ink);font-family:"Heebo","Segoe UI",Tahoma,sans-serif;font-size:11pt;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.n{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;white-space:nowrap}
header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:16px}
header img{height:68px;display:block}
h1{margin:0;font-size:22pt;font-weight:800;color:var(--navy);line-height:1.15}
.sub{color:var(--muted);font-size:10.5pt;margin-top:3px}
.lead{background:var(--navy);color:#fff;padding:14px 18px;font-size:14pt;font-weight:500;line-height:1.4;margin-bottom:16px}
.lead b{font-weight:800}
h2{margin:0 0 5px;font-size:13pt;font-weight:700;color:var(--navy)}
table{border-collapse:collapse;width:100%;font-size:10.5pt}
th,td{padding:3px 9px;text-align:right;border-bottom:1px solid var(--line)}
th{font-weight:500;color:var(--muted);font-size:9.5pt;border-bottom:1px solid var(--navy)}
th.g{text-align:center;color:var(--navy);font-weight:700;font-size:10.5pt;border-bottom:0;padding-bottom:1px}
td.x{text-align:left;direction:ltr;font-variant-numeric:tabular-nums;white-space:nowrap}
th.x{text-align:left;white-space:nowrap}
tr.t td{font-weight:700;background:var(--soft)}
tr.p td{font-weight:800;background:var(--tint);border-bottom:0}
.neg{color:var(--red)}
ul{margin:0;padding-right:17px} li{margin-bottom:4px}
.note{border-right:4px solid var(--acc);background:var(--tint);padding:9px 14px;margin:0 0 18px}
footer{margin-top:14px;padding-top:6px;border-top:1px solid var(--line);font-size:9pt;color:var(--muted)}
'''


def n(s):
    return f'<span class="n">{s}</span>'


def mil(v, d=2):
    return f'{v / 1e6:,.{d}f}'


def money_words(v):
    return f'{abs(v) / 1e6:.1f}'


def pc(v):
    return f'{v * 100:.1f}%'


def result_cell(r):
    word = 'הפסד' if r['profit'] < 0 else 'רווח'
    cls = ' class="neg"' if r['profit'] < 0 else ''
    return f'<b{cls}>{word} {n(money_words(r["profit"]))} מיליון ₪</b><small>{n(pc(r["pct"]))} מההכנסות</small>'


def unit_price(d, u):
    return d['sale_per_m2'] * (u['m2'] + u.get('outdoor_m2', 0) / 2)


def scenario_titles(d):
    fu = next((u for u in d['units'] if u.get('fixed_price')), None)
    if not fu:
        return [(f'לפי {n(f"{d["sale_per_m2"]:,.0f}")} ₪ למ"ר', '')]
    label = d.get('fixed_label') or fu['label']
    return [(f'{label} לפי מחיר למ"ר', f'{n(f"{d["sale_per_m2"]:,.0f}")} ₪ למ"ר, סה"כ {n(mil(unit_price(d, fu), 1))} מיליון ₪'),
            (f'{label} במחיר קבוע', f'{n(mil(fu["fixed_price"], 1))} מיליון ₪, כולל מע"מ')]


def header_html(d, logo, sub):
    return f'<header><div><h1>{d["name"]}</h1><div class="sub">{sub}</div></div><img src="data:image/png;base64,{logo}" alt="זרז\'בסקי"></header>'


def summary_lines(cols):
    def row(label, fn, cls=''):
        cells = ''.join(f'<td class="x{" neg" if fn(r) < 0 else ""}">{mil(fn(r))}</td>' for r in cols)
        return f'<tr class="{cls}"><td>{label}</td>{cells}</tr>'
    return row


def internal_html(d, xl, logo):
    rows = xl['rows']
    two = len(rows) > (3 if d.get('offer_per_m2') else 2)
    tgt = d['target_margin_pct']
    by = lambda ph_on, tag: next(r for r in rows if (r['ph'] > 0) == ph_on and r['tag'] == tag)
    scen = [False, True] if two else [False]
    titles = scenario_titles(d)
    cards = ''
    for s, (t, sb) in zip(scen, titles):
        offer = ''
        if d.get('offer_per_m2'):
            offer = f'<div class="row"><span class="q">בהצעה של<br>{n(f"{d["offer_per_m2"]:,.0f}")} ₪ למ"ר</span><span class="a">{result_cell(by(s, "offer"))}</span></div>'
        at = by(s, 'target')
        cards += f'''<div class="card"><div class="ct"><b>{t}</b><span>{sb}</span></div>
<div class="row"><span class="q">במחיר המבוקש<br>{n(f"{d["asking_per_m2"]:,.0f}")} ₪ למ"ר</span><span class="a">{result_cell(by(s, "ask"))}</span></div>{offer}
<div class="row hit"><span class="q">המחיר שנותן<br>{n(f"{tgt:g}%")} רווח יזמי</span><span class="a"><b class="huge">{n(f"{at["land"]:,.0f}")} ₪ למ"ר</b><small>סה"כ {n(mil(at["L"], 1))} מיליון ₪</small><small>רווח {n(money_words(at["profit"]))} מיליון ₪</small></span></div></div>'''
    cols = [r for s in scen for r in (by(s, 'ask'), by(s, 'target'))]
    row = summary_lines(cols)
    head1 = ''
    if two:
        head1 = '<tr><th style="border-bottom:0"></th>' + ''.join(f'<th class="g" colspan="2">{t}</th>' for t, _ in titles) + '</tr>'
    heads = ''.join(f'<th class="x">מחיר מבוקש</th><th class="x">יעד {n(f"{tgt:g}%")}</th>' for _ in scen)
    lands = ''.join(f'<td class="x">{r["land"]:,.0f}</td>' for r in cols)
    pcts = ''.join(f'<td class="x{" neg" if r["pct"] < 0 else ""}">{pc(r["pct"])}</td>' for r in cols)
    alt = ''
    if two:
        alt = f', או ב-<b>{n(f"{by(True, "target")["land"]:,.0f}")} ₪ למ"ר</b> בתרחיש {titles[1][0]}'
    verdict = 'הפרויקט מפסיד' if by(False, 'ask')['profit'] < 0 else 'הפרויקט מרוויח ' + pc(by(False, 'ask')['pct'])
    unit_rows, tot = '', 0.0
    for u in d['units']:
        v = unit_price(d, u) * u['qty']
        tot += v
        unit_rows += f'<tr><td>{u["label"]}</td><td class="x">{u["qty"]}</td><td class="x">{u["m2"]:g}</td><td class="x">{u.get("outdoor_m2", 0):g}</td><td class="x">{v:,.0f}</td></tr>'
    area = sum(u['m2'] * u['qty'] for u in d['units'])
    outd = sum(u.get('outdoor_m2', 0) * u['qty'] for u in d['units'])
    note = ''
    fu = next((u for u in d['units'] if u.get('fixed_price')), None)
    if fu:
        share = fu['fixed_price'] / by(True, 'ask')['gross']
        # Same basis as sale_per_m2: outdoor area counted at half
        like_for_like = fu['fixed_price'] / (fu['m2'] + fu.get('outdoor_m2', 0) / 2)
        note = f'<div class="note"><b>מה {n(mil(fu["fixed_price"], 1))} מיליון ₪ אומרים:</b> {n(f"{like_for_like:,.0f}")} ₪ למ"ר כשסופרים מרפסת וגג בחצי מ"ר, מול {n(f"{d["sale_per_m2"]:,.0f}")} ₪ בשאר הבניין. זו מכירה אחת שהיא {n(f"{share * 100:.0f}%")} מכל ההכנסות, וצריך עסקת השוואה שתתמוך במחיר הזה.</div>'
    li = lambda items: ''.join(f'<li>{i}</li>' for i in items)
    has_offer = bool(d.get('offer_per_m2'))
    sens_head1 = ''
    if two:
        span = 3 if has_offer else 2
        sens_head1 = '<tr><th style="border-bottom:0"></th>' + ''.join(f'<th class="g" colspan="{span}">{t}</th>' for t, _ in titles) + '</tr>'
    sens_head2 = ''
    for _ in scen:
        sens_head2 += f'<th class="x">רווח ב-{n(f"{d["asking_per_m2"]:,.0f}")}</th>'
        if has_offer:
            sens_head2 += f'<th class="x">אחוז ב-{n(f"{d["offer_per_m2"]:,.0f}")}</th>'
        sens_head2 += f'<th class="x">מחיר ל-{n(f"{tgt:g}%")}</th>'

    def sens_cells(get):
        out_cells = ''
        for s in scen:
            r = get(s)
            out_cells += f'<td class="x{" neg" if r["profit"] < 0 else ""}">{mil(r["profit"], 1)}</td>'
            if has_offer:
                out_cells += f'<td class="x{" neg" if r["offer_pct"] < tgt / 100 else ""}">{pc(r["offer_pct"])}</td>'
            out_cells += f'<td class="x">{r["solve"]:,.0f}</td>'
        return out_cells

    def base_row(s):
        ask = by(s, 'ask')
        return dict(profit=ask['profit'], solve=by(s, 'target')['land'], offer_pct=by(s, 'offer')['pct'] if has_offer else None)

    sens_rows = f'<tr class="t"><td>החישוב הרגיל</td>{sens_cells(base_row)}</tr>'
    for key, label, _ in SENSITIVITY:
        sens_rows += f'<tr><td>{label}</td>{sens_cells(lambda s: next(x for x in xl["sens"] if x["key"] == key and (x["ph"] > 0) == s))}</tr>'
    css = BASE_CSS + '''@page{size:A4;margin:10mm 15mm}
.cards{display:grid;grid-template-columns:repeat(COLS,1fr);gap:12px;margin-bottom:14px}
.card{border:1px solid var(--line);border-top:4px solid var(--navy)} .card+.card{border-top-color:var(--acc)}
.ct{padding:8px 14px;background:var(--soft)} .ct b{display:block;font-size:12pt;color:var(--navy);font-weight:700} .ct span{font-size:10pt;color:var(--muted)}
.row{display:grid;grid-template-columns:38% 1fr;gap:8px;padding:8px 14px;border-top:1px solid var(--line);align-items:center}
.q{font-size:10pt;color:var(--muted);line-height:1.35} .a b{display:block;font-size:12.5pt;font-weight:700} .a small{display:block;font-size:9.5pt;color:var(--muted)}
.a b.neg{color:var(--red)} .hit{background:var(--tint)} .hit .q{color:var(--ink);font-weight:500} .a b.huge{font-size:15pt;font-weight:800;color:var(--navy)}
.page2{break-before:page;font-size:10pt} section{margin-bottom:12px} .two{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.page2 table{font-size:9.5pt} .page2 th,.page2 td{padding:2px 7px} .page2 li{margin-bottom:2px} .page2 .note{margin-bottom:12px;padding:6px 12px}
'''.replace('COLS', str(len(scen)))
    return f'''<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>דוח אפס - {d["name"]}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap"><style>{css}</style></head><body>
{header_html(d, logo, f'דוח אפס · {n(d["date"])} · {d.get("subtitle", "")}')}
<div class="lead">במחיר המבוקש של {n(f"{d["asking_per_m2"]:,.0f}")} ₪ למ"ר {verdict}.<br>רווח יזמי של {n(f"{tgt:g}%")} מתקבל ב-<b>{n(f"{by(False, "target")["land"]:,.0f}")} ₪ למ"ר</b>{alt}.</div>
<div class="cards">{cards}</div>
<section><h2>סיכום הנתונים</h2><table>{head1}<tr><th>במיליוני ₪</th>{heads}</tr>
<tr><td>מחיר הקרקע, ₪ למ"ר</td>{lands}</tr>
{row('הכנסות כולל מע"מ', lambda r: r['gross'])}{row('הכנסות לפני מע"מ', lambda r: r['net'], 't')}
{row('קרקע', lambda r: r['L'])}{row(f'תיווך {n(f"{d["brokerage_pct"]:g}%")}', lambda r: r['brok'])}{row(f'מס רכישה {n(f"{d["purchase_tax_pct"]:g}%")}', lambda r: r['tax'])}
{row('בנייה ופיתוח', lambda r: r['direct'])}{row('תכנון, אגרות וחיבורים', lambda r: r['soft'])}{row('בצ"מ, שיווק, ניהול ומשפטי', lambda r: r['bzm'] + r['mkt'] + r['over'] + r['legal'])}{row('מימון', lambda r: r['fin'])}
{row('סה"כ עלויות', lambda r: r['cost'], 't')}{row('רווח יזמי', lambda r: r['profit'], 'p')}<tr class="p"><td>רווח יזמי מההכנסות</td>{pcts}</tr></table></section>
<div class="page2"><section><h2>מה קורה אם</h2><table>{sens_head1}<tr><th>רווח במיליוני ₪, מחיר ב-₪ למ"ר</th>{sens_head2}</tr>{sens_rows}</table>
<p style="margin:5px 0 0;font-size:9.5pt;color:var(--muted)">כל שורה משנה דבר אחד בלבד. אחוז באדום: מתחת ליעד. עלויות עקיפות 30% מהבנייה הישירה, במקום בצ"מ ותקורה.</p></section>
<section><h2>מה מוכרים</h2><table><tr><th>דירה</th><th class="x">כמות</th><th class="x">מ"ר</th><th class="x">מרפסת, גג או חצר</th><th class="x">סה"כ לפי {n(f"{d["sale_per_m2"]:,.0f}")} ₪, כולל מע"מ</th></tr>{unit_rows}
<tr class="t"><td>סה"כ</td><td class="x">{sum(u["qty"] for u in d["units"])}</td><td class="x">{area:,.1f}</td><td class="x">{outd:,.1f}</td><td class="x">{tot:,.0f}</td></tr></table></section>{note}
<div class="two"><section><h2>על מה החישוב נשען</h2><ul><li>רווח יזמי באחוזים: הרווח חלקי ההכנסות לפני מע"מ.</li>{li(d["basis"])}</ul></section>
<section><h2>מה עוד צריך לבדוק</h2><ul>{li(d["open_items"])}</ul></section></div>
<footer>דוח אפס ראשוני לצורך קבלת החלטה. אינו שומה ואינו תחליף לבדיקה משפטית, תכנונית והנדסית.</footer></div></body></html>'''


def seller_html(d, xl, logo):
    asks = [r for r in xl['rows'] if r['tag'] == 'ask']
    titles = scenario_titles(d)
    cards = ''.join(f'<div class="card"><span>{t}</span>{result_cell(r).split("<small>")[0]}</div>' for r, (t, _) in zip(asks, titles))
    row = summary_lines(asks)
    worst = asks[0]
    if worst['profit'] < 0:
        lead = f'במחיר של {n(f"{d["asking_per_m2"]:,.0f}")} ₪ למ"ר הפרויקט מפסיד, עוד לפני כל רווח ליזם.'
        if len(asks) > 1 and asks[1]['profit'] < 0:
            lead += f' זה נכון גם בתרחיש של {titles[1][0]}.'
    else:
        lead = f'במחיר של {n(f"{d["asking_per_m2"]:,.0f}")} ₪ למ"ר נשאר בפרויקט מרווח של {n(money_words(worst["profit"]))} מיליון ₪ בלבד.'
    heads = ''.join(f'<th class="x">{t}</th>' for t, _ in titles)
    css = BASE_CSS + f'''@page{{size:A4;margin:14mm 15mm}}
.cards{{display:grid;grid-template-columns:repeat({len(asks)},1fr);gap:12px;margin-bottom:20px}}
.card{{border:1px solid var(--line);padding:13px 16px;background:var(--soft)}} .card>span{{display:block;font-size:10.5pt;color:var(--muted)}}
.card b{{display:block;font-size:19pt;font-weight:800;color:var(--navy);line-height:1.3}} .card b.neg{{color:var(--red)}}
section{{margin-bottom:14px}} th,td{{padding:4px 9px}}'''
    html = f'''<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>{d["name"]} - בדיקה כלכלית</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap"><style>{css}</style></head><body>
{header_html(d, logo, f'בדיקה כלכלית למחיר המבוקש · {n(d["date"])} · {d.get("subtitle", "")}')}
<div class="lead">{lead}</div><div class="cards">{cards}</div>
<section><h2>החישוב במחיר של {n(f"{d["asking_per_m2"]:,.0f}")} ₪ למ"ר</h2><table><tr><th>במיליוני ₪</th>{heads}</tr>
{row('הכנסות כולל מע"מ', lambda r: r['gross'])}{row('הכנסות לפני מע"מ', lambda r: r['net'], 't')}{row('קרקע', lambda r: r['L'])}{row(f'תיווך {n(f"{d["brokerage_pct"]:g}%")}', lambda r: r['brok'])}{row(f'מס רכישה {n(f"{d["purchase_tax_pct"]:g}%")}', lambda r: r['tax'])}
{row('בנייה ופיתוח', lambda r: r['direct'])}{row('תכנון, אגרות וחיבורים', lambda r: r['soft'])}{row('בצ"מ, שיווק, ניהול ומשפטי', lambda r: r['bzm'] + r['mkt'] + r['over'] + r['legal'])}{row('מימון', lambda r: r['fin'])}
{row('סה"כ עלויות', lambda r: r['cost'], 't')}{row('תוצאה', lambda r: r['profit'], 'p')}</table></section>
<section><h2>על מה החישוב נשען</h2><ul>{''.join(f'<li>{i}</li>' for i in d.get('seller_basis', d['basis']))}</ul></section>
<footer>בדיקה ראשונית לצורך דיון. אינה שומה, אינה הצעה ואינה מחייבת.</footer></body></html>'''
    # The seller must never see the target, the ceiling or the offer
    text = re.sub(r'base64,[^"]+', '', html)
    forbidden = [f'{r["land"]:,.0f}' for r in xl['rows'] if r['tag'] in ('target', 'offer')] + [f'{d["target_margin_pct"]:g}%', 'יעד', 'רווח יזמי']
    leaks = [w for w in forbidden if w in text]
    if leaks:
        die(3, 'seller version leaks: ' + ', '.join(leaks))
    return html


def to_pdf(html, work, name):
    hp = os.path.join(work, name + '.html')
    open(hp, 'w', encoding='utf-8').write(html)
    pdf = os.path.join(work, name + '.pdf')
    ud = tempfile.mkdtemp(dir=work)
    subprocess.run([EDGE, '--headless=new', '--disable-gpu', f'--user-data-dir={ud}', '--no-pdf-header-footer', '--virtual-time-budget=6000', f'--print-to-pdf={pdf}', 'file:///' + hp.replace('\\', '/')], timeout=90, capture_output=True)
    if not os.path.exists(pdf):
        die(3, 'PDF was not created: ' + name)
    return pdf


def main():
    if len(sys.argv) != 2:
        die(2, 'usage: build_report.py deal.json')
    sys.stdout.reconfigure(encoding='utf-8')
    d = load(sys.argv[1])
    work = tempfile.mkdtemp(prefix='zero-report-')
    xlsx = os.path.join(work, 'report.xlsx')
    shutil.copy(TEMPLATE, xlsx)
    xl = excel_fill_and_calc(d, xlsx, os.path.join(work, 'results.json'))
    cross_check(d, xl)
    logo = base64.b64encode(open(LOGO, 'rb').read()).decode()
    p1 = to_pdf(internal_html(d, xl, logo), work, 'internal')
    p2 = to_pdf(seller_html(d, xl, logo), work, 'seller')
    os.makedirs(d['output_dir'], exist_ok=True)
    out = {
        'excel': os.path.join(d['output_dir'], f'דוח אפס - {d["name"]}.xlsx'),
        'internal_pdf': os.path.join(d['output_dir'], f'דוח אפס - {d["short"]} - סיכום.pdf'),
        'seller_pdf': os.path.join(d['output_dir'], f'{d["short"]} - בדיקה כלכלית - למוכר.pdf'),
    }
    shutil.copy(xlsx, out['excel']); shutil.copy(p1, out['internal_pdf']); shutil.copy(p2, out['seller_pdf'])
    print(json.dumps({'files': out, 'work_dir': work, 'cross_check': 'passed', 'rows': xl['rows']}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
