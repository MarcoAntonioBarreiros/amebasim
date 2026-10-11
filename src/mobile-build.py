"""Monta o app de celular: casca (mobile-shell.html) + núcleo + JS da página adaptado."""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
rd = lambda f: open(os.path.join(HERE, f), encoding='utf-8').read()
page = rd('page.html')
shell = rd('mobile-shell.html')
core = rd('amoeba-core.js')

# JS da página: o segundo <script> (depois do bloco do núcleo)
i = page.index('<script>\n/*__CORE__*/\n</script>') + len('<script>\n/*__CORE__*/\n</script>')
js = page[i:]

def rep(a, b):
    global js
    assert a in js, 'não encontrado: ' + a[:70]
    js = js.replace(a, b)

rep("let running = !reduce, speed = 2, seed = 7;", "let running = true, speed = 2, seed = 7;")
rep("const cam = { x: 0, y: 0, s: 1 };", "const cam = { x: 0, y: 0, s: 1, base: 1 };\n  let zoom = 1;")
rep("cam.s = Math.max(0.8, Math.min(2.1, Math.min(W, H) / 360)) * viewScale();",
    "cam.base = Math.max(0.8, Math.min(2.1, Math.min(W, H) / 360)) * viewScale(); cam.s = cam.base * zoom;")
rep("if (source.age >= SRC_HOLD + SRC_FADE) { source = null; $('hint').textContent = HINTS[scen]; }",
    "if (source.age >= SRC_HOLD + SRC_FADE) source = null;")
rep("$('chips').innerHTML = chips.map(t => `<span class=\"chip\">${t}</span>`).join('');",
    "$('chips').textContent = chips.length ? chips.join(', ') : 'nenhum';")
rep("$('btnClearSrc').addEventListener('click', () => { source = null; $('hint').textContent = HINTS[scen]; });",
    "$('btnClearSrc').addEventListener('click', () => { source = null; });")
rep("  $('btnPlay').addEventListener('click', () => { running = !running; $('btnPlay').textContent = running ? 'Pausar' : 'Continuar'; });\n", "")
rep("""  function syncTheme() {
    const dark = T.dark;""", """  function syncTheme() {
    const dark = T.dark;
    const mt = document.querySelector('meta[name="theme-color"]'); if (mt) mt.content = T.field;""")

# gestos: remove o pointerdown da página (toque único = micropipeta)
a = js.index("  cv.addEventListener('pointerdown', e => {")
b = js.index("  /* ── laço ── */")
js = js[:a] + js[b:]

rep("""    const m = am.metrics;
    cam.x += (m.cx - cam.x) * 0.05; cam.y += (m.cy - cam.y) * 0.05;
    draw();
    if (frame++ % 10 === 0) readouts();""", """    const m = am.metrics;
    cam.s += (cam.base * zoom - cam.s) * 0.2;
    cam.x += (m.cx - cam.x) * 0.05; cam.y += (m.cy - cam.y) * 0.05;
    draw();
    frame++;
    if (menuOpen && frame % 10 === 0) readouts();""")

APP = r"""
  /* ── app: menu de pausa, gestos, botão voltar, tela ligada, preferências ── */
  // modo proteção de tela (aberto pelo serviço do Android): só a simulação, sem interface
  const SAVER = /[?&]modo=protecao\b/.test(location.search);
  if (SAVER) document.documentElement.classList.add('saver');
  if (window.Capacitor && !SAVER) { const li = document.getElementById('howtoSaver'); if (li) li.hidden = false; }
  const menu = $('menu'), fab = $('btnMenu');
  let menuOpen = false;
  let idleT, toastT, wake = null;
  function wakeFab() { fab.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => fab.classList.add('idle'), 3500); }
  function toast(msg, ms) {
    const h = $('hint'); if (msg) h.textContent = msg;
    h.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => h.classList.remove('on'), ms || 3200);
  }
  async function requestWake() {
    try { if ('wakeLock' in navigator && !wake && running && !document.hidden) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { wake = null; }
  }
  function releaseWake() { try { if (wake) wake.release(); } catch (e) {} wake = null; }
  function openMenu() {
    if (menuOpen) return;
    menuOpen = true; running = false; menu.hidden = false; readouts(); releaseWake();
    setTimeout(() => $('btnResume').focus({ preventScroll: true }), 0);
  }
  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false; menu.hidden = true; running = true; wakeFab(); requestWake();
  }
  fab.addEventListener('click', openMenu);
  $('btnResume').addEventListener('click', closeMenu);
  menu.addEventListener('click', e => { if (e.target === menu) closeMenu(); });   // toque fora da folha retoma
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' || e.key === ' ' && !menuOpen) { e.preventDefault(); menuOpen ? closeMenu() : openMenu(); }
  });
  if (!SAVER) {
    // botão voltar do Android: abre/fecha o menu em vez de sair
    try { history.pushState({ ameba: 1 }, ''); } catch (e) {}
    window.addEventListener('popstate', () => {
      menuOpen ? closeMenu() : openMenu();
      try { history.pushState({ ameba: 1 }, ''); } catch (e) {}
    });
    // app em segundo plano: pausa (economiza bateria) e volta no menu
    document.addEventListener('visibilitychange', () => { if (document.hidden) openMenu(); });
  }

  // gestos: toque curto = micropipeta; pinça = zoom; roda do mouse = zoom
  const clampZ = z => Math.max(0.5, Math.min(3, z));
  const pts = new Map(); let tap = null, pinch = null;
  function placeSource(px, py) {
    const r = cv.getBoundingClientRect();
    const x = (px - r.left - W / 2) / cam.s + cam.x, y = (py - r.top - H / 2) / cam.s + cam.y;
    source = { x, y, age: 0 };
    toast(blood() ? 'Micropipeta de fMLP colocada. O sinal se esgota sozinho.' : 'Micropipeta colocada. O sinal se esgota sozinho.');
  }
  cv.addEventListener('pointerdown', e => {
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); wakeFab();
    if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: performance.now() };
    else { tap = null; const [p, q] = [...pts.values()]; pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, z: zoom }; }
  });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
    if (pinch && pts.size >= 2) { const [p, q] = [...pts.values()]; zoom = clampZ(pinch.z * Math.hypot(p.x - q.x, p.y - q.y) / pinch.d); }
  });
  const lift = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (tap && e.type === 'pointerup' && performance.now() - tap.t < 350) placeSource(e.clientX, e.clientY);
    tap = null;
  };
  cv.addEventListener('pointerup', lift); cv.addEventListener('pointercancel', lift);
  cv.addEventListener('wheel', e => { e.preventDefault(); zoom = clampZ(zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

  // preferências do usuário (ficam neste aparelho)
  const KEY = 'ameba-solgel-app-v1';
  function saveState() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        v: Object.fromEntries(SLIDERS.map(id => [id, $(id).value])), inhib, preyOn, grainOn, layers, speed, seed, scen, cellType,
        theme: document.documentElement.getAttribute('data-theme')
      }));
    } catch (e) {}
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!s) return;
      for (const id in (s.v || {})) if ($(id)) $(id).value = s.v[id];
      Object.assign(inhib, s.inhib || {});
      $('tBleb').setAttribute('aria-pressed', inhib.bleb ? 'true' : 'false');
      $('tCyto').setAttribute('aria-pressed', inhib.cyto ? 'true' : 'false');
      preyOn = s.preyOn !== false; $('tPrey').setAttribute('aria-pressed', preyOn ? 'true' : 'false');
      grainOn = !!s.grainOn; $('tGrain').setAttribute('aria-pressed', grainOn ? 'true' : 'false');
      Object.assign(layers, s.layers || {});
      for (const id in LMAP) $(id).checked = !!layers[LMAP[id]];
      speed = [1, 2, 4].includes(s.speed) ? s.speed : 2;
      for (const b of document.querySelectorAll('.seg button[data-sp]')) b.setAttribute('aria-pressed', +b.dataset.sp === speed ? 'true' : 'false');
      seed = Math.max(1, s.seed | 0) || 7; $('seed').value = seed;
      if (s.theme === 'light' || s.theme === 'dark') document.documentElement.setAttribute('data-theme', s.theme);
      // cenário salvo (um link com ?cenario=... tem prioridade)
      if (!urlScen && (s.scen === 'solo' || s.scen === 'sangue')) {
        scen = s.scen;
        if (s.cellType === 'macrofago' || s.cellType === 'neutrofilo') cellType = s.cellType;
      }
    } catch (e) {}
  }
  menu.addEventListener('input', saveState);
  menu.addEventListener('change', saveState);
  menu.addEventListener('click', () => setTimeout(saveState, 0));
  loadState();
  if (!SAVER) { wakeFab(); toast(null, 5200); requestWake(); }
"""
rep("\n  if (urlScen && blood()) {",
    APP + "\n  if (urlScen && blood()) {")
rep("\n  if (!running) $('btnPlay').textContent = 'Continuar';\n  readouts();\n  loop();", "\n  readouts();\n  loop();")

out = shell.replace('/*__CORE__*/', core) + js

# versão do app (www/index.html): manifesto, ícones e service worker para uso offline
PWA_HEAD = """<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/icon-192.png">
"""
PWA_SW = """
<script>
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
</script>
"""
dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'www', 'index.html')
if dest.endswith('index.html'):
    out = out.replace('<meta name="theme-color"', PWA_HEAD + '<meta name="theme-color"', 1) + PWA_SW
    out = '<!doctype html>\n<html lang="pt-BR">\n<meta charset="utf-8">\n' + out + '\n</html>\n'
with open(dest, 'w', encoding='utf-8') as f:
    f.write(out)
print('ok', dest, len(out))
