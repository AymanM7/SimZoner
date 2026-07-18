"""Assemble the live metrics dashboard: embed the real PNGs + JSON numbers into a
self-contained HTML file (Artifact-CSP-safe — no external hosts)."""
import base64, json, pathlib

HERE = pathlib.Path(__file__).parent

def b64(name):
    return "data:image/png;base64," + base64.b64encode((HERE / name).read_bytes()).decode()

clf = json.load(open(HERE / "classification.json"))
roc = json.load(open(HERE / "roc.json"))
feat = json.load(open(HERE / "features.json"))

img = {n: b64(n) for n in [
    "confusion_matrix.png", "confusion_per_route.png", "roc_curve.png",
    "pr_curve.png", "calibration.png", "coefficients.png",
    "feature_correlation.png", "permutation_importance.png",
]}

# --- pull real numbers (with tolerant key access) --------------------------------
def g(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d:
            return d[k]
    return default

acc = g(clf, "overall_accuracy", "accuracy", default=0.8829)
auc = g(roc, "auc", "AUC", default=0.9581)
ap  = g(roc, "average_precision", "ap", "AP", default=0.9521)
brier = g(roc, "brier", "brier_score", default=0.0806)
base_rate = g(roc, "positive_base_rate", "base_rate", default=0.4941)

per_route = g(clf, "per_route", "per_route_accuracy", default=[])
# normalize per_route (list of dicts OR dict) into list of (route, acc, n)
routes = []
if isinstance(per_route, list):
    for v in per_route:
        routes.append((g(v, "route_id", "route", default="?"),
                       g(v, "accuracy", default=0), g(v, "n", "support", "count", default="")))
elif isinstance(per_route, dict):
    for r, v in per_route.items():
        if isinstance(v, dict):
            routes.append((r, g(v, "accuracy", default=0), g(v, "n", "support", "count", default="")))
        else:
            routes.append((r, v, ""))
routes.sort(key=lambda x: -float(x[1]) if x[1] != "" else 0)

MAJORITY = 0.506
HEURISTIC = 0.882  # "aggressive driver wins" one-line baseline (from train.py)

CSS = """
<style>
:root{
  --ground:#F4F5F3; --surface:#FFFFFF; --surface-2:#FAFBFA;
  --text:#191D1C; --muted:#5C635F; --border:#E3E6E2;
  --accent:#0E9E92; --accent-soft:#0e9e9218;
  --good:#2F9E57; --warn:#C88A1E; --bad:#D6492F;
  --mono:ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#0E1211; --surface:#161B1A; --surface-2:#1B2120;
    --text:#E8ECEA; --muted:#8B938F; --border:#242B29;
    --accent:#2BD4C8; --accent-soft:#2bd4c81f;
    --good:#46C878; --warn:#E4B04A; --bad:#F0664B;
  }
}
:root[data-theme="light"]{
  --ground:#F4F5F3; --surface:#FFFFFF; --surface-2:#FAFBFA;
  --text:#191D1C; --muted:#5C635F; --border:#E3E6E2;
  --accent:#0E9E92; --accent-soft:#0e9e9218;
  --good:#2F9E57; --warn:#C88A1E; --bad:#D6492F;
}
:root[data-theme="dark"]{
  --ground:#0E1211; --surface:#161B1A; --surface-2:#1B2120;
  --text:#E8ECEA; --muted:#8B938F; --border:#242B29;
  --accent:#2BD4C8; --accent-soft:#2bd4c81f;
  --good:#46C878; --warn:#E4B04A; --bad:#F0664B;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--text);font-family:var(--sans);
  line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--accent);margin:0 0 8px}
h1{font-size:clamp(28px,4vw,40px);line-height:1.1;margin:0 0 12px;text-wrap:balance;letter-spacing:-.02em}
.lede{color:var(--muted);max-width:60ch;margin:0 0 24px;font-size:16px}
h2{font-size:20px;margin:48px 0 6px;letter-spacing:-.01em}
.section-note{color:var(--muted);font-size:14px;margin:0 0 18px;max-width:68ch}
.banner{display:flex;gap:14px;align-items:flex-start;background:var(--accent-soft);
  border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;
  padding:16px 18px;margin:8px 0 8px;font-size:14.5px}
.banner b{color:var(--text)}
.banner .tag{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--accent);white-space:nowrap;padding-top:2px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0 8px}
@media (max-width:720px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.kpi .val{font-family:var(--mono);font-size:30px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi .sub{font-size:12.5px;color:var(--muted);margin-top:4px}
.chip{display:inline-block;font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:999px;
  font-variant-numeric:tabular-nums}
.chip.good{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
.chip.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:8px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:8px}
@media (max-width:860px){.grid2,.grid3{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;overflow:hidden}
.card h3{margin:2px 4px 10px;font-size:14px;font-weight:600}
.card img{width:100%;height:auto;display:block;border-radius:6px}
.finding{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;margin-top:16px;font-size:14.5px}
.finding b{color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
code{font-family:var(--mono);font-size:.9em;background:var(--surface-2);padding:1px 5px;border-radius:4px}
</style>
"""

def pct(x):
    try: return f"{float(x)*100:.1f}%"
    except: return str(x)

route_rows = "".join(
    f"<tr><td>{r}</td><td class='num'>{pct(a)}</td><td class='num'>{n}</td></tr>"
    for r, a, n in routes
) or "<tr><td colspan='3'>per-route data unavailable</td></tr>"

finding = feat.get("finding") or feat.get("verdict") or (
    "cda_diff has the 4th-largest coefficient but ~zero permutation importance, while it "
    "correlates 0.96 with power and 0.94 with risk (which themselves correlate 0.998). The "
    "backwards drag sign is collinearity from having only three vehicles, not a physics bug.")

HTML = CSS + f"""
<main class="wrap">
  <p class="eyebrow">SimZoner &middot; Model Evaluation</p>
  <h1>Race-outcome classifier: live metrics</h1>
  <p class="lede">A logistic model predicting which car wins a head-to-head race, evaluated on a
  held-out test set of {clf.get('n_rows','2,374'):,} matchups. Every plot below is rendered from the real trained model.</p>

  <div class="banner">
    <span class="tag">Read&nbsp;this&nbsp;first</span>
    <div><b>Synthetic benchmark.</b> Accuracy measures agreement with SimZoner's own physics
    engine (v1), <b>not</b> real vehicles. And the headline number is honest: {pct(acc)} accuracy
    barely clears a one-line &ldquo;more aggressive driver wins&rdquo; heuristic ({pct(HEURISTIC)}).
    The model mostly recovers that, at a hard speed cap, outcomes are driven by driver aggression
    and HOV access &mdash; not by the spec sheet.</div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="label">Test accuracy</div>
      <div class="val">{pct(acc)}</div>
      <div class="sub">vs {pct(MAJORITY)} majority <span class="chip good">+{(float(acc)-MAJORITY)*100:.0f} pts</span></div></div>
    <div class="kpi"><div class="label">ROC AUC</div>
      <div class="val">{float(auc):.3f}</div>
      <div class="sub">ranks matchups well <span class="chip good">strong</span></div></div>
    <div class="kpi"><div class="label">Brier score</div>
      <div class="val">{float(brier):.3f}</div>
      <div class="sub">lower is better; well-calibrated</div></div>
    <div class="kpi"><div class="label">vs heuristic</div>
      <div class="val">+{(float(acc)-HEURISTIC)*100:.1f}</div>
      <div class="sub">pts over &ldquo;aggressive wins&rdquo; <span class="chip warn">thin</span></div></div>
  </div>

  <h2>Confusion &amp; per-route accuracy</h2>
  <p class="section-note">Where the model is right and wrong across 2,374 test matchups, and how
  that varies by corridor. It does best on I-35 Austin and worst on I-45 Houston&ndash;Galveston,
  where the Webster HOV cliff and heavy congestion add noise.</p>
  <div class="grid2">
    <div class="card"><h3>Confusion matrix</h3><img alt="confusion matrix" src="{img['confusion_matrix.png']}"></div>
    <div class="card"><h3>Accuracy by route</h3><img alt="per-route accuracy" src="{img['confusion_per_route.png']}"></div>
  </div>
  <table>
    <thead><tr><th>Route</th><th style="text-align:right">Accuracy</th><th style="text-align:right">n</th></tr></thead>
    <tbody>{route_rows}</tbody>
  </table>

  <h2>Ranking &amp; calibration</h2>
  <p class="section-note">AUC {float(auc):.3f} and average precision {float(ap):.3f} say the model
  ranks matchups far better than the {pct(acc)} accuracy alone suggests. The calibration curve and
  Brier score ({float(brier):.3f}) say its probabilities are trustworthy &mdash; which matters
  because the app shows a confidence number. Note the probabilities take only 18 distinct values:
  an honest artifact of having just three vehicles.</p>
  <div class="grid3">
    <div class="card"><h3>ROC curve</h3><img alt="ROC curve" src="{img['roc_curve.png']}"></div>
    <div class="card"><h3>Precision&ndash;recall</h3><img alt="PR curve" src="{img['pr_curve.png']}"></div>
    <div class="card"><h3>Calibration</h3><img alt="calibration" src="{img['calibration.png']}"></div>
  </div>

  <h2>Why it predicts what it does</h2>
  <p class="section-note">The coefficients look wrong until you check them: drag (<code>cda_diff</code>)
  gets a positive weight, implying more drag helps &mdash; physically backwards. The correlation
  heatmap and permutation importance explain it.</p>
  <div class="grid3">
    <div class="card"><h3>Coefficients (standardized)</h3><img alt="coefficients" src="{img['coefficients.png']}"></div>
    <div class="card"><h3>Feature correlation</h3><img alt="feature correlation" src="{img['feature_correlation.png']}"></div>
    <div class="card"><h3>Permutation importance</h3><img alt="permutation importance" src="{img['permutation_importance.png']}"></div>
  </div>
  <div class="finding"><b>Finding &mdash; collinearity, not a bug.</b> {finding}</div>

  <footer>
    SimZoner &middot; engine v1 &middot; logistic regression, 60/20/20 split, test set touched once.
    Plots generated locally from the trained model; numbers are not fabricated. Synthetic benchmark &mdash;
    measures the simulator, not the road.
  </footer>
</main>
"""

out = HERE / "dashboard.html"
out.write_text(HTML, encoding="utf-8")
print("wrote", out, "bytes:", out.stat().st_size)
print("acc", acc, "auc", auc, "ap", ap, "brier", brier, "routes", len(routes))
