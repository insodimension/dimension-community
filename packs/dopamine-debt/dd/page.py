import base64
import html as H
from pathlib import Path

CSS = """
body{margin:0;background:#0b0b0f;color:#e3e5e6;font:15px/1.55 "Inter",-apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:1240px;margin:0 auto;padding:36px 28px 80px}
h1{font-size:40px;margin:0;color:#e0b15b;letter-spacing:-.02em} h2{font-size:21px;margin:48px 0 12px;border-top:1px solid #232327;padding-top:24px}
.sub{color:#8c8d90;margin:6px 0 0} .legend{color:#8c8d90;font-size:12.5px}
.verdict{display:flex;gap:28px;align-items:center;background:#131317;border-radius:16px;padding:22px;flex-wrap:wrap}
.big{font-size:68px;font-weight:800;color:#e0b15b;line-height:1}.big small{font-size:20px;color:#6f7174}
.pill{display:inline-block;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:700}
.pass{background:#1a2e21;color:#a6e0b8}.fail{background:#3a1714;color:#f3938a}.incomplete{background:#33280f;color:#e0a44e}.na{background:#232327;color:#8c8d90}
table{width:100%;border-collapse:collapse;font-size:13px} td,th{border-bottom:1px solid #232327;padding:7px 9px;vertical-align:top;text-align:left} th{color:#e0b15b;font-weight:600}
.chart{width:100%;background:#131317;border-radius:12px;margin:8px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:14px}
.card{background:#131317;border-radius:12px;overflow:hidden;border-top:4px solid var(--c)} .card img{width:100%;display:block}
.card .ph{height:96px;background:#0f0f13;display:flex;align-items:center;justify-content:center;color:#6f7174;font-size:12px;padding:8px;text-align:center}
.card p{margin:8px 12px;font-size:13px} .meta{color:#8c8d90;font-size:11.5px;margin:4px 12px 10px} .mv{display:inline-block;margin:0 12px;background:#e0a44e;color:#0b0b0f;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:800}
.bar{display:inline-block;height:6px;border-radius:3px;background:#e0b15b;vertical-align:middle}
.k{color:#6f7174}
"""

AUD_COL = ["#e0b15b", "#6b93d6", "#60c57f", "#e95245"]


def _img(path):
    p = Path(path)
    if not p.exists():
        return None
    return "data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode()


def _curve(ledgers, W=1160, Hh=260):
    dur = next(iter(ledgers.values()))["duration"]
    theta = next(iter(ledgers.values()))["theta"]
    top = max(theta * 1.6, max(max(L["series"]) for L in ledgers.values()) + 0.5)
    y = lambda v: 16 + (1 - v / top) * (Hh - 40)
    x = lambda t: t / dur * W
    out = [f'<svg viewBox="-34 0 {W+44} {Hh+18}" class="chart">',
           f'<rect x="0" y="16" width="{W}" height="{y(theta)-16:.1f}" fill="#e95245" opacity=".07"/>',
           f'<line x1="0" x2="{W}" y1="{y(theta):.1f}" y2="{y(theta):.1f}" stroke="#e95245" stroke-dasharray="6 5"/>',
           f'<text x="{W-4}" y="{y(theta)-5:.1f}" fill="#f3938a" font-size="11" text-anchor="end">θ = {theta}: click-away line (unfitted)</text>',
           f'<line x1="0" x2="{W}" y1="{y(0):.1f}" y2="{y(0):.1f}" stroke="#43454a"/>']
    for t in range(0, int(dur) + 1, 30):
        out.append(f'<text x="{x(t):.1f}" y="{Hh+12}" fill="#6f7174" font-size="10" text-anchor="middle">{t//60}:{t%60:02d}</text>')
    for i, (aud, L) in enumerate(ledgers.items()):
        pts = " ".join(f"{x(t):.1f},{y(d):.1f}" for t, d in enumerate(L["series"]))
        c = AUD_COL[i % len(AUD_COL)]
        out.append(f'<polyline points="{pts}" fill="none" stroke="{c}" stroke-width="2.5"/>')
        out.append(f'<text x="6" y="{30+14*i}" fill="{c}" font-size="12">debt · {H.escape(aud)}</text>')
        for b in L["bits"].values():
            if b["laugh"]:
                out.append(f'<text x="{x(b["t1"]):.1f}" y="{y(0)+16+10*i:.1f}" font-size="11" text-anchor="middle" fill="{c}">●<title>{H.escape(b["text"][:120])} · P(laugh) {b["p"]["laugh"]:.2f}</title></text>')
    out.append("</svg>")
    return "".join(out)


def _worst(L, n=3, win=15):
    s = L["series"]
    picks, used = [], set()
    for t in sorted(range(len(s)), key=lambda i: -s[i]):
        if any(abs(t - u) < win for u in used) or s[t] <= 0:
            continue
        used.add(t)
        segs = [r for r in L["segments"].values() if r["kind"] != "silence" and r["t0"] <= t + 1 and r["t1"] >= t - win]
        heavy = [r for r in segs if r.get("heavy")]
        picks.append((t, s[t], heavy))
        if len(picks) == n:
            break
    return picks


def render(path, title, film, ledgers, per, fg, sc, frames=None, notes=""):
    frames = frames or {}
    gated = list(ledgers)
    rows = []
    for name, gv in fg.items():
        rows.append(f'<tr><td>{H.escape(name)}</td><td>film</td><td><span class="pill {gv["status"]}">{gv["status"]}</span></td><td>{H.escape(gv["detail"])}</td></tr>')
    for a in gated:
        for name, gv in per[a].items():
            rows.append(f'<tr><td>{H.escape(name)}</td><td>{H.escape(a)}</td><td><span class="pill {gv["status"]}">{gv["status"]}</span></td><td>{H.escape(gv["detail"])}</td></tr>')
    parts = "".join(f'<tr><td>{H.escape(a)}</td><td><b>{v["score"]}</b></td>' + "".join(f'<td><span class="bar" style="width:{int(60*p)}px"></span> {p:.2f}</td>' for p in v["parts"].values()) + "</tr>" for a, v in sc["per_audience"].items())
    head = "".join(f"<th>{H.escape(k)}</th>" for k in next(iter(sc["per_audience"].values()))["parts"])
    worst = []
    for a in gated:
        for t, d, heavy in _worst(ledgers[a]):
            moves = "; ".join(f'{r["id"]} → {r.get("move","")}: “{H.escape(r.get("line","")[:70])}”' for r in heavy) or "no single heavy unit: a long stretch without reward"
            worst.append(f"<tr><td>{H.escape(a)}</td><td>{t//60}:{t%60:02d}</td><td>{d:.1f}</td><td>{moves}</td></tr>")
    L0 = ledgers[gated[0]]
    cards = []
    for s in film["segments"]:
        if s["kind"] == "silence":
            continue
        r0 = L0["segments"][s["id"]]
        b0 = L0["bits"][r0["bit"]]
        net = r0.get("net", 0.0)
        col = "#60c57f" if net >= 1 else ("#8c8d90" if net > -1 else "#e95245")
        im = _img(frames[s["id"]]) if s["id"] in frames else None
        top = f'<img src="{im}">' if im else f'<div class="ph">{H.escape((s.get("picture") or s["kind"])[:140])}</div>'
        per_aud = " · ".join(f'{H.escape(a)}: lost {ledgers[a]["segments"][s["id"]]["p"]["lost"]:.2f}, laugh {ledgers[a]["bits"][r0["bit"]]["p"]["laugh"]:.2f}' for a in gated)
        mv = f'<span class="mv">{H.escape(r0["move"])}</span>' if r0.get("move") else ""
        facts = ",".join(r0.get("facts", []))
        cards.append(f'<div class="card" style="--c:{col}">{top}<p>{"“"+H.escape(s.get("line",""))+"”" if s.get("line") else "<i>"+H.escape(s.get("sound_line") or s.get("sound") or "")+"</i>"}</p>'
                     f'{mv}<div class="meta">{s["t0"]:.1f}–{s["t1"]:.1f}s · net {net:+.1f} · {per_aud}{" · facts " + facts if facts else ""}{" · cringe " + format(b0["cringe"], ".2f") if b0["cringe"] >= 0.15 else ""}</div></div>')
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>{H.escape(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"><style>{CSS}</style></head><body><main>
<h1>{H.escape(title)}</h1><p class="sub">Dopamine Debt v2 · judge {H.escape(film.get('judge_model',''))} · gated audiences: {H.escape(', '.join(gated))}</p>
<h2>Verdict</h2><div class="verdict"><div class="big">{sc['score']:.0f}<small> / 100 ± {sc['sd']}</small></div>
<div><p>{'<span class="pill fail">capped at 49: ' + str(sc['failing']) + ' gate(s) failing</span>' if sc['capped'] else '<span class="pill pass">all gates pass</span>'}</p>
<p class="legend">Raw {sc['raw']} before the cap. The score is the minimum over audiences of a geometric mean, for ranking versions of this film only; differences under 2 SD are noise. Gates decide.</p></div></div>
<table><tr><th>audience</th><th>score</th>{head}</tr>{parts}</table>
<h2>Gates</h2><table><tr><th>gate</th><th>for</th><th>status</th><th>evidence</th></tr>{''.join(rows)}</table>
<h2>Debt meter, per second</h2><p class="legend">Strain builds with effort, confusion and cringe, decays with τ = 20 s, and is paid down by laughs (●), clicks and closed loops. A generic laugh clears at most half; a declared payoff clears it all.</p>{_curve(ledgers)}
<h2>Worst stretches</h2><table><tr><th>audience</th><th>at</th><th>debt</th><th>heavy units and the move</th></tr>{''.join(worst)}</table>
<h2>Storyboard</h2><p class="legend">Colour = the unit's own net (reward − cost) for {H.escape(gated[0])}: green pays, grey neutral, red costs.</p><div class="grid">{''.join(cards)}</div>
{notes}
</main></body></html>"""
    Path(path).write_text(doc, encoding="utf8")
    return path
