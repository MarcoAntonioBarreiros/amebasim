/* ═══════════════════════════════════════════════════════════════════════
   amoeba-core.js — núcleo de simulação do movimento ameboide (modelo sol-gel)

   Convenção de integração igual à da DarwinRizo (classe VP): cada ponto guarda
   a posição atual (x, y) e a anterior (ox, oy); velocidade = x − ox.
   Não depende de DOM nem de variáveis globais do hospedeiro. O hospedeiro
   (página de ajuste, ferramenta de animação, DarwinRizo, Miguelito) chama
   step(env) e desenha a partir de nodes, particles e pods.

   Modelo (Mast, atualizado com a leitura molecular):
   • Membrana = anel de nós com restrição de ÁREA (volume conservado).
   • Córtex posterior contrai (miosina II): os segmentos traseiros encurtam,
     a área cai e a pressão empurra a membrana onde o córtex é fraco — a ponta
     do pseudópode (calota hialina, sem gel recém-formado).
   • Gelificação: nós e partículas junto à membrana viram gel com o tempo
     (rede de actina); na ponta, o córtex ainda é sol. No uroide, o gel solata.
   • Adesão ("embreagem"): nós em gel ancoram no substrato. As forças internas
     não deslocam o centro da célula (baixo número de Reynolds, sem força
     externa); só as âncoras transmitem tração. Sem adesão, a célula deforma
     mas não sai do lugar.
   • Remalhamento: segmentos esticados na ponta ganham nós novos (membrana nova,
     ainda sol); segmentos encurtados no uroide perdem nós. É a esteira
     ectoplasma → endoplasma.
   • Endoplasma: partículas em estado sol fluem para a ponta, com velocidade
     amarrada ao avanço real da ponta; ao chegar à calota, desviam para os
     lados (fluxo em fonte) e gelificam no tubo ectoplasmático, que fica
     parado em relação ao substrato.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULTS = {
    radius: 60,          // raio inicial (px)
    nodeSpacing: 8,      // comprimento de repouso de um segmento de membrana (px)
    particles: 380,      // inclusões do citoplasma (grânulos, cristais, vacúolos)
    contraction: 0.6,    // miosina II no córtex posterior (0–1)
    adhesion: 0.6,       // força das adesões ao substrato, a "embreagem" (0–1)
    gelation: 0.5,       // taxa de gelificação sol → gel (0–1); 0 = citocalasina
    chemotaxis: 0.6,     // peso do gradiente quimiotático (0–1)
    pseudopodRate: 0.5,  // frequência de novos pseudópodes (0–1)
    podWidth: 20,        // meia-largura do braço principal ao longo da membrana (px)
    ectoThickness: 8,    // espessura do tubo ectoplasmático (px)
    capDepth: 8,         // profundidade da calota hialina (px)
    minThickness: 28,    // espessura mínima de qualquer trecho da célula (px)
    contractileVacuole: true, // protistas de água doce têm; leucócitos não
    nucleusRadius: 10,
    crystalFrac: 0.14,   // cristais bipiramidais (próprios de Amoeba proteus)
    vacuoleFrac: 0.035,  // vacúolos / lisossomos
    flowSpeed: 1.0,      // escala do fluxo do endoplasma
    iterations: 6,       // iterações das restrições por passo (VIT na DarwinRizo)
    maxNodes: 220,
    minNodes: 16,
    seed: 7
  };

  class Amoeba {
    constructor(x, y, opts) {
      this.p = Object.assign({}, DEFAULTS, opts || {});
      this.rng = mulberry32((this.p.seed >>> 0) || 1);
      this.t = 0;
      this.L0 = this.p.nodeSpacing;
      this.nodes = [];
      this.particles = [];
      this.pods = [];
      const R = this.p.radius;
      const n = Math.max(this.p.minNodes, Math.round(TAU * R / this.L0));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        this.nodes.push(this._node(x + Math.cos(a) * R, y + Math.sin(a) * R, 0.9));
      }
      this.A0 = this.geom().A;
      this._initParticles(x, y, R);
      const g = this.geom();
      this._prevC = { x: g.x, y: g.y };
      this.metrics = { clutch: 0, speed: 0, vx: 0, vy: 0, endoSpeed: 0, ratio: 0, pressure: 0,
                       tipSpeed: 0, heading: this.rng() * TAU, nodeCount: n, anchors: 0, sense: 0 };
      this._normals();
      this.counts = { engulfed: 0, digested: 0, systoles: 0 };
      this.tips = [];
      this._polar = 0.5;
    }

    setParams(o) { Object.assign(this.p, o); }

    _node(x, y, gel) {
      return { x, y, ox: x, oy: y, sx: x, sy: y, gel, tip: 0, rear: 0, retr: 0, fx: 0, fy: 0, pdx: 0, pdy: 0, hit: false, tl: 0,
               anch: false, ax: 0, ay: 0, nx: 0, ny: 0, th: 0 };
    }

    _gauss() { const r = this.rng; return (r() + r() + r() + r() - 2) * 1.2; }

    _initParticles(cx, cy, R) {
      const P = this.p, rng = this.rng;
      const put = (type, r, gelBias) => {
        let x, y, tries = 0;
        do {
          const a = rng() * TAU, d = Math.sqrt(rng()) * (R - r - 4);
          x = cx + Math.cos(a) * d; y = cy + Math.sin(a) * d; tries++;
        } while (tries < 20 && this.particles.some(q => Math.hypot(q.x - x, q.y - y) < q.r + r));
        const edge = R - Math.hypot(x - cx, y - cy);
        this.particles.push({ type, x, y, vx: 0, vy: 0, r, u: rng(),
          gel: gelBias != null ? gelBias : (edge < P.ectoThickness + r ? 1 : 0),
          phase: rng(), digest: 0, digestMax: 0, spin: rng() * TAU });
      };
      put('nucleus', P.nucleusRadius, 0);
      if (P.contractileVacuole) put('cv', 3, 0);
      const nVac = Math.round(P.particles * P.vacuoleFrac);
      const nCry = Math.round(P.particles * P.crystalFrac);
      for (let i = 0; i < nVac; i++) put('vacuole', 3 + rng() * 2.2);
      for (let i = 0; i < nCry; i++) put('crystal', 1.5 + rng() * 0.6);
      const rest = Math.max(0, P.particles - nVac - nCry);
      for (let i = 0; i < rest; i++) put('granule', 1.2 + rng() * 1.1);
    }

    /* Área com sinal e centróide de área do polígono da membrana */
    geom() {
      const N = this.nodes, n = N.length;
      let A = 0, cx = 0, cy = 0;
      for (let i = 0; i < n; i++) {
        const a = N[i], b = N[(i + 1) % n];
        const cr = a.x * b.y - b.x * a.y;
        A += cr; cx += (a.x + b.x) * cr; cy += (a.y + b.y) * cr;
      }
      A *= 0.5;
      if (Math.abs(A) < 1e-6) return { A: 0, x: N[0].x, y: N[0].y };
      return { A, x: cx / (6 * A), y: cy / (6 * A) };
    }

    _normals() {
      const N = this.nodes, n = N.length;
      for (let i = 0; i < n; i++) {
        const a = N[(i - 1 + n) % n], b = N[i], c = N[(i + 1) % n];
        let ex = b.x - a.x, ey = b.y - a.y, fx = c.x - b.x, fy = c.y - b.y;
        const l1 = Math.hypot(ex, ey) || 1, l2 = Math.hypot(fx, fy) || 1;
        let nx = ey / l1 + fy / l2, ny = -ex / l1 - fx / l2;
        const l = Math.hypot(nx, ny) || 1;
        b.nx = nx / l; b.ny = ny / l;
      }
    }

    pointInside(x, y) {
      const N = this.nodes, n = N.length;
      let ins = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = N[i], b = N[j];
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
      }
      return ins;
    }

    /* Aresta mais próxima de um ponto: distância, índice, parâmetro e normal externa */
    nearestEdge(x, y, out) {
      const N = this.nodes, n = N.length;
      let bd = Infinity, bi = 0, bt = 0;
      for (let i = 0; i < n; i++) {
        const a = N[i], b = N[(i + 1) % n];
        const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey || 1e-9;
        const t = clamp(((x - a.x) * ex + (y - a.y) * ey) / l2, 0, 1);
        const px = a.x + ex * t, py = a.y + ey * t;
        const d = (x - px) * (x - px) + (y - py) * (y - py);
        if (d < bd) { bd = d; bi = i; bt = t; }
      }
      const a = N[bi], b = N[(bi + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey) || 1;
      out.d = Math.sqrt(bd); out.i = bi; out.t = bt;
      out.px = a.x + ex * bt; out.py = a.y + ey * bt;
      out.nx = ey / l; out.ny = -ex / l;           // normal externa (polígono com área positiva)
      out.tip = a.tip * (1 - bt) + b.tip * bt;
      out.rear = a.rear * (1 - bt) + b.rear * bt;
      return out;
    }

    /* ── Pseudópodes: braços que crescem, tateiam, ramificam e recolhem ──
       Cada pseudópode é um foco de polimerização preso a um ponto da membrana
       (o nó-ponta) e cresce na própria direção, que oscila (tateio), é puxada
       pelo gradiente e desviada por obstáculos. Ciclo de vida: crescer →
       sustentar → retrair (miosina recolhe o braço). Novos focos nascem nos
       flancos de um braço existente (ramificação) ou no corpo. O braço mais
       bem alinhado ao gradiente se renova e vira o pseudópode-guia. */
    _newPod(node, dir, s, gen) {
      const r = this.rng, P = this.p;
      gen = gen || 0;
      // geração 0 = braço principal; 1 = ramo; 2 = lóbulo (contorno nodoso)
      const w = P.podWidth * [1, 0.7, 0.45][gen];
      const f = [1, 0.55, 0.28][gen];
      return { node, dir, s: clamp(s, 0.08, 1), gen, w, age: 0, rAge: 0, phase: 'grow', amp: 0,
               grow: (160 + r() * 220) * f, hold: (60 + r() * 140) * f, rDur: (110 + r() * 90) * Math.max(0.45, f),
               side: r() < 0.5 ? -1 : 1, lx: node.x, ly: node.y, idx: this.nodes.indexOf(node), lead: false, str: 0, al: 0 };
    }

    /* ── Sensor quimiotático: direção e intensidade (0–1) do gradiente num ponto ──
       env.gradient(x, y) → vetor cuja norma já é a resposta da célula (0–1);
       env.target {x, y} é o caso simples de uma fonte única de intensidade máxima. */
    _sense(env, x, y) {
      if (env && env.gradient) {
        const g = env.gradient(x, y), m = g ? Math.hypot(g.x, g.y) : 0;
        return m > 1e-6 ? { ang: Math.atan2(g.y, g.x), str: clamp(m, 0, 1) } : null;
      }
      if (env && env.target) return { ang: Math.atan2(env.target.y - y, env.target.x - x), str: 1 };
      return null;
    }

    _updatePods(env, c) {
      const P = this.p, rng = this.rng, N = this.nodes, n = N.length, pods = this.pods;
      const cs = this._sense(env, c.x, c.y);
      this.metrics.sense = cs ? cs.str : 0;
      const actin = Math.min(1, P.gelation * 2);

      // reencontra o nó-ponta de cada foco (a membrana é remalhada a cada passo)
      for (const k of pods) {
        let i = N.indexOf(k.node);
        if (i < 0) {
          let bd = Infinity;
          for (let j = 0; j < n; j++) { const d = (N[j].x - k.lx) ** 2 + (N[j].y - k.ly) ** 2; if (d < bd) { bd = d; i = j; } }
        }
        const ca = Math.cos(k.dir), sa = Math.sin(k.dir), win = k.gen === 0 ? 4 : 0;   // ramos e lóbulos ficam presos ao próprio nó (não escorregam para a ponta-mãe)
        let best = i, bv = -Infinity;
        for (let o = -win; o <= win; o++) {
          const j = (i + o + n) % n, v = N[j].x * ca + N[j].y * sa;
          if (v > bv) { bv = v; best = j; }
        }
        k.idx = best; k.node = N[best]; k.lx = k.node.x; k.ly = k.node.y;
      }

      // dois focos na mesma ponta viram um só (o maior absorve o outro)
      for (let i = 0; i < pods.length; i++) for (let j = pods.length - 1; j > i; j--) {
        const a = pods[i], b = pods[j];
        if (a.phase === 'retract' || b.phase === 'retract') continue;
        let d = Math.abs(a.idx - b.idx); d = Math.min(d, n - d);
        if (d <= Math.max(1, Math.round(Math.min(a.w, b.w) / (2 * this.L0)))) {
          const [keep, drop] = (a.gen < b.gen || (a.gen === b.gen && a.s >= b.s)) ? [a, b] : [b, a];
          keep.s = Math.max(a.s, b.s);
          pods.splice(pods.indexOf(drop), 1); if (drop === a) { i--; break; }
        }
      }

      // guia = braço principal ativo de maior mérito: força acumulada + alinhamento ao gradiente
      // (com histerese, para o guia não trocar a cada passo)
      const merit = k => k.s + 0.8 * k.str * Math.max(0, k.al || 0) + (k.lead ? 0.15 : 0);
      let lead = null;
      for (const k of pods) if (k.phase !== 'retract' && k.gen === 0 && (!lead || merit(k) > merit(lead))) lead = k;

      const sm = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
      for (const k of pods) {
        k.age++; k.lead = k === lead;
        const nd = k.node;
        // cada pseudópode lê o gradiente na própria ponta
        let align = 0;
        const g = this._sense(env, nd.x, nd.y);
        k.str = g ? g.str : 0;
        if (g) {
          align = Math.cos(angDiff(k.dir, g.ang));
          k.al = align;
          k.dir += P.chemotaxis * g.str * (k.gen ? 0.012 : 0.024) * Math.sin(angDiff(g.ang, k.dir));
        }
        // tateio: a direção oscila; ramos e lóbulos oscilam mais
        k.dir += (rng() - 0.5) * (0.12 + 0.08 * k.gen) * (0.25 + P.pseudopodRate);
        k.dir += 0.03 * Math.sin(angDiff(Math.atan2(nd.ny, nd.nx), k.dir));
        // obstáculo na ponta: desvia para um lado e tende a ramificar
        if (nd.hit) {
          k.dir += k.side * 0.22;
          // contornando o grão para longe do gradiente: o braço desiste e recolhe
          if (g && g.str > 0.1 && Math.cos(angDiff(k.dir, g.ang)) < -0.05 && k.phase !== 'retract') { k.phase = 'retract'; k.rAge = 0; }
          if (rng() < 0.05 && pods.length < 14 && k.gen < 2) {
            const j = (k.idx - k.side * 3 + n) % n;
            pods.push(this._newPod(N[j], k.dir - k.side * 0.9, k.s * 0.8, k.gen + 1));
          }
        }
        const gain = P.chemotaxis * k.str * align * 0.9 + (k.lead ? 0.35 : -0.05) - 0.1;
        k.s = clamp(k.s + 0.006 * gain, 0.06, 1);

        if (k.phase === 'grow' && k.age > k.grow) k.phase = 'hold';
        if (k.phase === 'hold' && k.age > k.grow + k.hold) { k.phase = 'retract'; k.rAge = 0; }
        const perim = this.metrics.perimRatio || 1;
        if (k.lead && k.phase === 'hold' && perim < 2.0 && (k.str > 0.15 ? align > 0.2 : rng() < 0.004)) { k.phase = 'grow'; k.age = k.grow * 0.4; }
        // reserva de membrana no limite: nenhum braço continua crescendo
        if (perim > 2.15 && k.phase === 'grow') { k.phase = 'hold'; k.age = Math.max(k.age, k.grow); }
        if (k.phase === 'retract') k.rAge++;
        k.amp = k.phase === 'grow' ? sm(k.age / (20 + 25 * (k.w / P.podWidth))) : k.phase === 'hold' ? 1 : 1 - sm(k.rAge / k.rDur);
      }
      for (let i = pods.length - 1; i >= 0; i--) if (pods[i].phase === 'retract' && pods[i].rAge > pods[i].rDur) pods.splice(i, 1);

      // competição entre pseudópodes: um vence, o outro recolhe
      // (a) dois braços em lados opostos de um grão: o mais fraco cede (a célula não abraça o grão)
      // (b) reserva de membrana quase esgotada: o braço não-guia mais fraco recolhe
      const score = k => k.s * (0.5 + 0.5 * k.amp) + 0.8 * k.str * Math.max(0, k.al || 0) + (k.lead ? 0.3 : 0);
      const act = pods.filter(k => k.phase !== 'retract' && k.gen < 2 && k.age > 15);
      const obs = this._obs;
      if (obs && obs.length && act.length > 1) {
        const near = obs.filter(o => Math.hypot(o.x - c.x, o.y - c.y) < 350 && !this.pointInside(o.x, o.y));
        for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
          const A = act[i], B = act[j];
          if (A.phase === 'retract' || B.phase === 'retract') continue;
          const a = A.node, b = B.node, ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey || 1e-9;
          for (const o of near) {
            const t = ((o.x - a.x) * ex + (o.y - a.y) * ey) / l2;
            if (t <= 0.05 || t >= 0.95) continue;
            if (Math.hypot(a.x + ex * t - o.x, a.y + ey * t - o.y) < o.r * 0.95) {
              const loser = score(A) < score(B) ? A : B;
              loser.phase = 'retract'; loser.rAge = 0;
              break;
            }
          }
        }
      }
      if ((this.metrics.perimRatio || 1) > 2.15) {
        const cand = act.filter(k => !k.lead && k.phase !== 'retract');
        if (cand.length) { const w = cand.reduce((m, k) => score(k) < score(m) ? k : m); w.phase = 'retract'; w.rAge = 0; }
      }

      // nascimento de focos: ramo no flanco, bifurcação da ponta, lóbulo, ou braço novo no corpo
      if (rng() < P.pseudopodRate * 0.12 * actin && pods.length < 20 && (this.metrics.perimRatio || 1) < 1.9) {
        const act = pods.filter(k => k.phase !== 'retract' && k.age > 30 && k.gen < 2);
        const roll = rng();
        if (act.length && roll < 0.36) {
          // ramo/lóbulo saindo do flanco, um pouco atrás da ponta
          const par = act[(rng() * act.length) | 0], side = rng() < 0.5 ? -1 : 1;
          const back = Math.max(2, Math.round((0.6 + rng() * 1.4) * par.w / this.L0));
          const j = (par.idx - side * back + n) % n;
          pods.push(this._newPod(N[j], par.dir + side * (0.5 + rng() * 0.7), par.s * 0.7, par.gen + 1));
        } else if (act.length && roll < 0.52) {
          // bifurcação: a ponta se divide em dois dedos e o foco-mãe para de crescer
          const par = act[(rng() * act.length) | 0];
          if (par.phase === 'hold' || par.age > par.grow * 0.5) {
            const o = Math.max(1, Math.round(0.4 * par.w / this.L0)), spread = 0.35 + rng() * 0.35;
            const g = Math.min(2, par.gen + 1);
            pods.push(this._newPod(N[(par.idx + o) % n], par.dir - spread, par.s * 0.85, g));
            pods.push(this._newPod(N[(par.idx - o + n) % n], par.dir + spread, par.s * 0.85, g));
            if (!par.lead) { par.phase = 'hold'; par.age = Math.max(par.age, par.grow + par.hold * 0.7); }
          }
        } else if (roll < 0.86 || pods.filter(k => k.gen === 0 && k.phase !== 'retract').length >= 3) {
          // lóbulo pequeno em qualquer ponto ativo da membrana (contorno nodoso)
          const cand = N.filter(nd => nd.rear < 0.25 && nd.retr < 0.1);
          if (cand.length) {
            const nd = cand[(rng() * cand.length) | 0];
            pods.push(this._newPod(nd, Math.atan2(nd.ny, nd.nx) + this._gauss() * 0.25, 0.3, 2));
          }
        } else {
          // braço principal novo na metade dianteira do corpo
          const front = N.filter(nd => nd.rear < 0.12 && nd.tip < 0.2);
          if (front.length) {
            const nd = front[(rng() * front.length) | 0];
            let d = Math.atan2(nd.ny, nd.nx) + this._gauss() * 0.3;
            const g = this._sense(env, nd.x, nd.y);
            if (g && rng() < P.chemotaxis * g.str) d += 0.5 * angDiff(g.ang, d);
            pods.push(this._newPod(nd, d, 0.4, 0));
          }
        }
      }
      // sem braço-guia ativo: forma um novo (é ele que define a cauda que vai contrair)
      if (pods.length < 20 && !pods.some(k => k.phase !== 'retract' && k.gen === 0)) {
        const ha = cs && cs.str > 0.05 ? cs.ang : this.metrics.heading + this._gauss() * 0.5;
        let best = N[0], bv = -Infinity;
        for (const nd of N) { const v = (nd.x - c.x) * Math.cos(ha) + (nd.y - c.y) * Math.sin(ha); if (v > bv) { bv = v; best = nd; } }
        pods.push(this._newPod(best, ha, 0.6, 0));
      }

      // polarização: alta quando um braço guia domina (com gradiente); baixa ao tatear livremente
      const pol = lead ? clamp(lead.s * (0.5 + 0.3 * (cs ? cs.str : 0)), 0, 1) : 0.3;
      this._polar += ((this._polar === undefined ? pol : pol) - (this._polar || 0)) * 0.02;
      let hx = 0, hy = 0;
      for (const k of pods) if (k.phase !== 'retract') { const w = k.amp * k.s * (k.gen ? 0.3 : 1); hx += Math.cos(k.dir) * w; hy += Math.sin(k.dir) * w; }
      if (hx * hx + hy * hy > 1e-9) this.metrics.heading = Math.atan2(hy, hx);
    }

    /* ── Estado de cada nó: ponta (tip), retração de braço, uroide, gel do córtex ── */
    _updateNodes(c) {
      const P = this.p, N = this.nodes, n = N.length, main = this.metrics.heading;
      // comprimento de arco acumulado, para medir distâncias AO LONGO da membrana
      const arc = this._arc || (this._arc = []);
      arc.length = n; let L = 0;
      for (let i = 0; i < n; i++) { arc[i] = L; const a = N[i], b = N[(i + 1) % n]; L += Math.hypot(b.x - a.x, b.y - a.y); }
      let smax = 0.05; for (const k of this.pods) if (k.phase !== 'retract') smax = Math.max(smax, k.s);
      for (const nd of N) { nd.tip = 0; nd.retr = 0; nd.pdx = nd.nx; nd.pdy = nd.ny; }
      for (const k of this.pods) {
        const w = k.w, w2 = 2 * w * w, wr2 = 2 * (1.6 * w) ** 2;
        const i0 = k.idx, a0 = arc[i0];
        const reach = Math.ceil((k.phase === 'retract' ? 1.6 : 1) * w * 2.6 / this.L0) + 1;
        const gw = [1, 0.95, 0.85][k.gen];
        for (let o = -reach; o <= reach; o++) {
          const j = (i0 + o + n) % n;
          let d = Math.abs(arc[j] - a0); d = Math.min(d, L - d);
          const nd = N[j];
          if (k.phase === 'retract') {
            const r = Math.exp(-d * d / wr2) * clamp(k.rAge / 25, 0, 1) * (0.5 + 0.5 * k.s) * gw;
            if (r > nd.retr) nd.retr = r;
          } else {
            const t = k.amp * (0.35 + 0.65 * k.s / smax) * gw * Math.exp(-d * d / w2);
            if (t > nd.tip) { nd.tip = t; nd.pdx = Math.cos(k.dir); nd.pdy = Math.sin(k.dir); }
          }
        }
      }
      // uroide: tudo o que está atrás do centro, ao longo da direção de avanço
      const hx = Math.cos(main), hy = Math.sin(main);
      let back = 1;
      for (const nd of N) back = Math.max(back, -((nd.x - c.x) * hx + (nd.y - c.y) * hy));
      this.metrics.perimRatio = L / (this._perim0 || (this._perim0 = L));
      // com braço-guia, o uroide também é medido AO LONGO da membrana a partir da ponta-guia:
      // numa célula enrolada em "C" em volta de um grão, a cauda continua sendo reconhecida
      const lead = this.pods.find(k => k.lead && k.phase !== 'retract');
      const a0 = lead ? arc[lead.idx] : 0, half = L / 2;
      const sm = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
      for (let i = 0; i < n; i++) {
        const nd = N[i];
        nd.tip = clamp(nd.tip, 0, 1);
        nd.th = Math.atan2(nd.y - c.y, nd.x - c.x);
        const up = clamp(-((nd.x - c.x) * hx + (nd.y - c.y) * hy) / back, 0, 1);
        let u = up * (0.4 + 0.6 * up);
        nd.tl = 0;
        if (lead) {
          let d = Math.abs(arc[i] - a0); d = Math.min(d, L - d);
          const ua = sm((d / half - 0.5) / 0.5);
          u = Math.max(u * 0.6, ua);
          // sentido, ao longo da membrana, que leva ao braço-guia pelo caminho mais curto
          const fwd = (a0 - arc[i] + L) % L;
          nd.tl = fwd < L - fwd ? 1 : -1;
        }
        nd.rear = u * (1 - nd.tip) * (0.45 + 0.55 * this._polar);
        // córtex: gelifica fora da ponta; na ponta permanece sol (calota hialina); renovação lenta
        nd.gel += P.gelation * 0.06 * (1 - nd.gel) * (1 - nd.tip) - 0.05 * nd.tip * nd.gel - 0.004 * nd.gel;
        nd.gel = clamp(nd.gel, 0, 1);
      }
    }

    /* ── Forças na membrana (regime viscoso: velocidade = força / atrito) ──
       Ativas: protrusão nas pontas dos braços (polimerização + pressão gerada
       pela contração posterior), retração no uroide e nos braços que recolhem
       (miosina II). A fração que não é transmitida ao substrato pela adesão é
       força interna: deforma a célula mas não desloca o centro (correção em step). */
    _membraneForces() {
      const P = this.p, N = this.nodes;
      let gs = 0, gw = 0;
      for (const nd of N) { const w = 1 - nd.tip; gs += nd.gel * w; gw += w; }
      const gelMean = gw > 0 ? gs / gw : 0;
      const clutch = clamp(P.adhesion * Math.min(1, gelMean * 1.6), 0, 1);
      this.metrics.clutch = clutch;

      const fRear = 0.85 * P.contraction;
      // a membrana tem reserva limitada: perto do limite, a ponta perde força
      const reserve = clamp((2.1 - (this.metrics.perimRatio || 1)) / 0.6, 0, 1);
      const actin = Math.min(1, P.gelation * 2);
      const fTip = (0.75 * P.contraction * (0.25 + 0.75 * actin) + 0.18 * actin) * reserve;
      const fRet = 0.45 * (0.25 + P.contraction);
      const n = N.length;
      for (let i = 0; i < n; i++) {
        const nd = N[i];
        // a ponta avança na direção do braço (não só pela normal): é isso que estica o braço
        const ft = fTip * nd.tip, fb = fRear * nd.rear + fRet * nd.retr;
        nd.fx = ft * (0.6 * nd.pdx + 0.4 * nd.nx) - fb * nd.nx;
        nd.fy = ft * (0.6 * nd.pdy + 0.4 * nd.ny) - fb * nd.ny;
        // a cauda é puxada para frente AO LONGO do corpo (encurta a célula, não só a afina)
        if (nd.tl) {
          const q = N[(i + nd.tl + n) % n];
          let tx = q.x - nd.x, ty = q.y - nd.y; const tl = Math.hypot(tx, ty) || 1;
          const fa = 0.7 * fRear * nd.rear;
          nd.fx += tx / tl * fa; nd.fy += ty / tl * fa;
        }
        const fm = Math.hypot(nd.fx, nd.fy);
        if (fm > 1.1) { nd.fx *= 1.1 / fm; nd.fy *= 1.1 / fm; }
      }
      for (const nd of N) {
        const mob = 1 / (1 + 4 * clutch * (nd.anch ? 1 : 0));
        nd.x += nd.fx * mob; nd.y += nd.fy * mob;
      }
    }

    /* ── Restrições passivas: área (volume), tensão de membrana, espaçamento, auto-contato ── */
    _constraints() {
      const P = this.p, N = this.nodes;
      for (let it = 0; it < P.iterations; it++) {
        const n = N.length;
        // volume é restaurado aos poucos (no máx. ~0,4% por iteração): perda súbita não vira estilingue
        const A = this.geom().A, C = clamp(A - this.A0, -0.004 * this.A0, 0.004 * this.A0);
        let den = 0;
        for (let i = 0; i < n; i++) {
          const pv = N[(i - 1 + n) % n], nx = N[(i + 1) % n], nd = N[i];
          nd._gx = 0.5 * (nx.y - pv.y); nd._gy = 0.5 * (pv.x - nx.x);
          // volume sobrando (braços cresceram): recolhe no uroide e nos braços em retração;
          // volume faltando: a membrana cede onde está ativa
          nd._w = C > 0 ? (0.15 + 2 * nd.rear + 1.5 * nd.retr) * (1 - 0.85 * nd.tip)
                        : 0.25 + 1.2 * nd.tip;
          den += nd._w * (nd._gx * nd._gx + nd._gy * nd._gy);
        }
        if (den > 1e-9) {
          const lam = (-C / den) * 0.8;
          for (const nd of N) { nd.x += lam * nd._w * nd._gx; nd.y += lam * nd._w * nd._gy; }
        }
      }
      // tensão (componente normal do laplaciano) e espaçamento (componente tangencial);
      // a tensão sobe quando a reserva de membrana se esgota
      const tens = 0.25 * clamp(((this.metrics.perimRatio || 1) - 1.8) / 0.6, 0, 1);
      const n = N.length, tx = new Float64Array(n), ty = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = N[(i - 1 + n) % n], b = N[i], c = N[(i + 1) % n];
        const lx = (a.x + c.x) * 0.5 - b.x, ly = (a.y + c.y) * 0.5 - b.y;
        let ex = c.x - a.x, ey = c.y - a.y; const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
        const lt = lx * ex + ly * ey;
        const nlx = lx - lt * ex, nly = ly - lt * ey;
        const kn = (0.03 + 0.12 * b.rear + 0.05 * b.retr) * (1 - 0.8 * b.tip) + tens;
        tx[i] = b.x + nlx * kn + ex * lt * 0.4;
        ty[i] = b.y + nly * kn + ey * lt * 0.4;
      }
      for (let i = 0; i < n; i++) { N[i].x = tx[i]; N[i].y = ty[i]; }
      // auto-contato: braços vizinhos não se atravessam, e nenhum trecho do corpo
      // afina abaixo de uma espessura mínima (o citoplasma não vira um fio)
      const L0 = this.L0, mNear = 0.9 * L0, mFar = P.minThickness, far = 8;
      for (let i = 0; i < n; i++) for (let j = i + 4; j < n; j++) {
        const sep = Math.min(j - i, n - (j - i));
        if (sep < 4) continue;
        const m = sep >= far ? mFar : mNear, m2 = m * m;
        const a = N[i], b = N[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= m2 || d2 < 1e-9) continue;
        const d = Math.sqrt(d2), o = (m - d) / d * 0.25;
        a.x -= dx * o; a.y -= dy * o; b.x += dx * o; b.y += dy * o;
      }
    }

    /* ── Remalhamento: membrana nova na ponta, removida no uroide ── */
    _remesh() {
      const P = this.p, N = this.nodes, L0 = this.L0;
      // com a reserva de membrana esgotada, só divide segmentos muito esticados
      // (nunca deixa um segmento virar uma corda longa, que atravessaria obstáculos)
      const splitAt = (this.metrics.perimRatio || 1) < 2.3 ? 1.5 * L0 : 2 * L0;
      for (let i = 0; i < N.length && N.length < P.maxNodes; i++) {
        const a = N[i], b = N[(i + 1) % N.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) > splitAt) {
          const nn = this._node((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(a.gel, b.gel) * 0.5);
          nn.ox = (a.ox + b.ox) / 2; nn.oy = (a.oy + b.oy) / 2;
          nn.sx = (a.sx + b.sx) / 2; nn.sy = (a.sy + b.sy) / 2;
          nn.tip = (a.tip + b.tip) / 2; nn.rear = (a.rear + b.rear) / 2; nn.retr = (a.retr + b.retr) / 2;
          nn.nx = (a.nx + b.nx) / 2; nn.ny = (a.ny + b.ny) / 2;
          N.splice(i + 1, 0, nn); i++;
        }
      }
      for (let i = 0; i < N.length && N.length > P.minNodes; i++) {
        const j = (i + 1) % N.length, a = N[i], b = N[j];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 0.55 * L0) {
          a.x = (a.x + b.x) / 2; a.y = (a.y + b.y) / 2;
          a.ox = (a.ox + b.ox) / 2; a.oy = (a.oy + b.oy) / 2;
          a.sx = (a.sx + b.sx) / 2; a.sy = (a.sy + b.sy) / 2;
          a.gel = Math.max(a.gel, b.gel);
          if (!a.anch && b.anch) { a.anch = true; a.ax = b.ax; a.ay = b.ay; }
          for (const k of this.pods) if (k.node === b) k.node = a;
          N.splice(j, 1);
          if (j < i) i--;
        }
      }
    }

    /* ── Desembaraço: se a membrana se cruzar, o laço menor é cortado ── */
    _untangle() {
      const N = this.nodes;
      for (let pass = 0; pass < 3; pass++) {
        const n = N.length; let fixed = false;
        for (let i = 0; i < n && !fixed; i++) {
          const a = N[i], b = N[(i + 1) % n];
          const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x), miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
          for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const c = N[j], d = N[(j + 1) % n];
            if (Math.max(c.x, d.x) < minx || Math.min(c.x, d.x) > maxx || Math.max(c.y, d.y) < miny || Math.min(c.y, d.y) > maxy) continue;
            const r1 = b.x - a.x, r2 = b.y - a.y, s1 = d.x - c.x, s2 = d.y - c.y;
            const den = r1 * s2 - r2 * s1;
            if (Math.abs(den) < 1e-9) continue;
            const t = ((c.x - a.x) * s2 - (c.y - a.y) * s1) / den, u = ((c.x - a.x) * r2 - (c.y - a.y) * r1) / den;
            if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
            // nós i+1..j formam um laço; o complemento é o outro. Remove o menor.
            const px = a.x + r1 * t, py = a.y + r2 * t;
            // dos dois laços, mantém o de maior área positiva (o corpo); o outro é dobra ou buraco
            const loopIn = N.slice(i + 1, j + 1), loopOut = N.slice(j + 1).concat(N.slice(0, i + 1));
            const area = poly => { let s2 = px * poly[0].y - poly[0].x * py; for (let q = 0; q < poly.length; q++) { const u = poly[q], v = q + 1 < poly.length ? poly[q + 1] : { x: px, y: py }; s2 += u.x * v.y - v.x * u.y; } return s2 / 2; };
            let kept = area(loopIn) > area(loopOut) ? loopIn : loopOut;
            // se o laço mantido englobaria um grão (braços que se fecharam atrás dele),
            // descruza invertendo o trecho i+1..j em vez de cortar: nenhum grão fica dentro
            const obs = this._obs;
            if (obs && obs.length) {
              const inside = (poly, x, y) => { let ins = false; for (let p = 0, q = poly.length - 1; p < poly.length; q = p++) { const u = poly[p], v = poly[q]; if ((u.y > y) !== (v.y > y) && x < ((v.x - u.x) * (y - u.y)) / (v.y - u.y) + u.x) ins = !ins; } return ins; };
              if (obs.some(o => inside(kept, o.x, o.y))) {
                const seg = N.slice(i + 1, j + 1).reverse();
                for (let q = 0; q < seg.length; q++) N[i + 1 + q] = seg[q];
                fixed = true; break;
              }
            }
            if (kept.length < this.p.minNodes) { fixed = true; break; }
            const nn = this._node(px, py, (a.gel + c.gel) / 2);
            kept.push(nn);
            for (const k of this.pods) if (!kept.includes(k.node)) k.node = nn;
            N.length = 0; for (const q of kept) N.push(q);
            fixed = true; break;
          }
        }
        if (!fixed) break;
      }
    }

    /* ── Adesões: formam-se no córtex em gel atrás das pontas e soltam no uroide ── */
    _anchors() {
      const P = this.p, rng = this.rng;
      let count = 0;
      for (const nd of this.nodes) {
        if (nd.anch) {
          if (nd.rear > 0.32 || nd.retr > 0.3 || nd.tip > 0.25 || nd.gel < 0.2 || P.adhesion <= 0.02 || Math.hypot(nd.ax - nd.x, nd.ay - nd.y) > 3 + 10 * P.adhesion) nd.anch = false;
          else count++;
        } else if (P.adhesion > 0.02 && nd.gel > 0.4 && nd.rear < 0.22 && nd.tip < 0.3 && nd.retr < 0.2 && rng() < 0.1) {
          nd.anch = true; nd.ax = nd.x; nd.ay = nd.y;
        }
      }
      this.metrics.anchors = count;
    }

    /* ── Obstáculos (grãos de solo): colisão de nós E de segmentos da membrana ──
       Um grão cujo centro já está dentro da célula (situação que não deveria
       ocorrer) é ignorado até sair, para nunca virar âncora. */
    _external(env) {
      const N = this.nodes, n = N.length;
      for (const nd of N) nd.hit = false;
      if (!env) return;
      const B = env.bounds;
      // obstáculo móvel (ex.: hemácia) que foi parar dentro da célula é expulso pela borda mais próxima;
      // obstáculo fixo (grão) nessa situação é ignorado, para nunca virar âncora
      if (env.obstacles) {
        const ne = {};
        for (const o of env.obstacles) if (o.mobile && this.pointInside(o.x, o.y)) {
          this.nearestEdge(o.x, o.y, ne);
          o.x = ne.px + ne.nx * (o.r + 2); o.y = ne.py + ne.ny * (o.r + 2);
        }
      }
      const obs = env.obstacles ? env.obstacles.filter(o => !this.pointInside(o.x, o.y)) : null;
      this.metrics.enclosed = env.obstacles ? env.obstacles.length - obs.length : 0;
      if (obs && obs.length) for (let pass = 0; pass < 2; pass++) {
        for (const nd of N) for (const o of obs) {
          const dx = nd.x - o.x, dy = nd.y - o.y, d = Math.hypot(dx, dy), m = o.r + 1;
          if (d < m && d > 1e-6) {
            // obstáculo móvel divide o deslocamento com a membrana (a célula empurra a hemácia)
            const push = m - d, k = o.mobile ? (o.give || 0.6) : 0;
            nd.x += dx / d * push * (1 - k); nd.y += dy / d * push * (1 - k);
            o.x -= dx / d * push * k; o.y -= dy / d * push * k;
            nd.hit = true;
          }
        }
        // segmento que corta o grão: empurra as duas pontas para fora pelo ponto mais próximo
        for (let i = 0; i < n; i++) {
          const a = N[i], b = N[(i + 1) % n], ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey || 1e-9;
          for (const o of obs) {
            const t = clamp(((o.x - a.x) * ex + (o.y - a.y) * ey) / l2, 0, 1);
            const px = a.x + ex * t, py = a.y + ey * t, dx = px - o.x, dy = py - o.y, d = Math.hypot(dx, dy), m = o.r + 1;
            if (d >= m) continue;
            let ux, uy;
            if (d > 1e-6) { ux = dx / d; uy = dy / d; } else { const l = Math.sqrt(l2); ux = -ey / l; uy = ex / l; }
            const push = m - d, k = o.mobile ? (o.give || 0.6) : 0;
            a.x += ux * push * (1 - t) * (1 - k); a.y += uy * push * (1 - t) * (1 - k);
            b.x += ux * push * t * (1 - k); b.y += uy * push * t * (1 - k);
            o.x -= ux * push * k; o.y -= uy * push * k;
            a.hit = b.hit = true;
          }
        }
      }
      if (B) for (const nd of N) { nd.x = clamp(nd.x, B.x0, B.x1); nd.y = clamp(nd.y, B.y0, B.y1); }
    }

    /* ── Passo completo ── */
    step(env) {
      const N = this.nodes;
      this.t++;
      this._obs = env && env.obstacles ? env.obstacles : null;
      for (const nd of N) { nd.sx = nd.x; nd.sy = nd.y; nd.ox = nd.x; nd.oy = nd.y; }
      const c0 = this.geom();
      this._updatePods(env, c0);
      this._updateNodes(c0);
      this._normals();
      this._membraneForces();
      this._constraints();
      // salvaguarda numérica: nenhum nó anda mais que 4 px num passo
      for (const nd of N) {
        const dx = nd.x - nd.sx, dy = nd.y - nd.sy, d = Math.hypot(dx, dy);
        if (!(d <= 4)) { const f = d > 0 && isFinite(d) ? 4 / d : 0; nd.x = nd.sx + dx * f; nd.y = nd.sy + dy * f; }
      }
      this._remesh();
      this._untangle();
      // só a fração da força ativa transmitida pela embreagem desloca o centro;
      // o restante é força interna (deforma a célula sem transladá-la)
      const c1 = this.geom(), k = 1 - this.metrics.clutch;
      const sx = (c0.x - c1.x) * k, sy = (c0.y - c1.y) * k;
      for (const nd of N) { nd.x += sx; nd.y += sy; }
      this._external(env);
      this._anchors();
      this._normals();

      // velocidade de avanço da ponta (referencial do substrato)
      let ts = 0, tw = 0;
      for (const nd of N) if (nd.tip > 0.4) {
        ts += ((nd.x - nd.sx) * nd.nx + (nd.y - nd.sy) * nd.ny) * nd.tip; tw += nd.tip;
      }
      const tip = tw > 0 ? ts / tw : 0;
      this.metrics.tipSpeed += (tip - this.metrics.tipSpeed) * 0.05;

      const c = this.geom();
      this._stepParticles(env, c);
      this._engulf(env);

      const vx = c.x - this._prevC.x, vy = c.y - this._prevC.y;
      this._prevC = { x: c.x, y: c.y };
      const m = this.metrics;
      m.vx += (vx - m.vx) * 0.03; m.vy += (vy - m.vy) * 0.03;
      m.speed = Math.hypot(m.vx, m.vy);
      m.pressure = (this.A0 - c.A) / this.A0;
      m.nodeCount = N.length;
      m.cx = c.x; m.cy = c.y;
    }

    _stepParticles(env, c) {
      const P = this.p, N = this.nodes, parts = this.particles;
      // ponto de chegada de cada braço = seu nó-ponta; braços em retração não recebem fluxo
      const tips = [];
      let tw = 0;
      for (const k of this.pods) if (k.phase !== 'retract') { const r = k.w / P.podWidth, w = k.amp * k.s * r * r + 0.01; tips.push({ x: k.node.x, y: k.node.y, ang: k.dir, s: w }); tw += w; }
      for (const t of tips) t.s /= tw || 1;
      this.tips = tips;
      // velocidade do endoplasma amarrada ao avanço da ponta (continuidade) + empuxo da contração
      const U = P.flowSpeed * (0.25 + 0.3 * P.contraction + 1.8 * Math.max(0, this.metrics.tipSpeed));
      const ecto = P.ectoThickness, cap = P.capDepth;
      const ne = {};
      let rearPt = null, rv = -Infinity;
      const ha = this.metrics.heading;
      for (const nd of N) { const v = -((nd.x - c.x) * Math.cos(ha) + (nd.y - c.y) * Math.sin(ha)); if (v > rv) { rv = v; rearPt = nd; } }

      let eSum = 0, eN = 0;
      const mdx = Math.cos(ha), mdy = Math.sin(ha);

      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const p = parts[pi];
        this.nearestEdge(p.x, p.y, ne);
        const inside = this.pointInside(p.x, p.y);
        const depth = inside ? ne.d : -ne.d;

        if (p.type === 'granule' || p.type === 'crystal' || p.type === 'vacuole') {
          if (depth < ecto + p.r && ne.tip < 0.35 && ne.rear < 0.4) p.gel += P.gelation * 0.08 * (1 - p.gel);
          else if (depth < ecto * 0.6 + P.capDepth * ne.tip ** 3 + p.r + 2 && ne.tip >= 0.35) p.gel += P.gelation * 0.05 * (1 - p.gel);  // gelificação na zona de fonte
          else if (ne.rear > 0.35) p.gel -= 0.07 * ne.rear * (0.3 + P.contraction) * p.gel;   // solação no uroide
          else if (depth > ecto * 1.7) p.gel -= 0.025 * p.gel;
          p.gel = clamp(p.gel, 0, 1);
        } else p.gel = 0;

        let tvx = 0, tvy = 0;
        const sol = 1 - p.gel;
        if (p.type === 'cv') {
          // vacúolo contrátil migra para o uroide e pulsa (diástole lenta, sístole rápida)
          const dx = rearPt.x - p.x, dy = rearPt.y - p.y, d = Math.hypot(dx, dy) || 1;
          tvx = dx / d * 0.25; tvy = dy / d * 0.25;
          p.phase += 1 / 420;
          if (p.phase >= 1) { p.phase = 0; this.counts.systoles++; }
          p.r = 2.5 + 6 * p.phase * p.phase;
        } else if (sol > 0.05 && tips.length) {
          let acc = 0, k = 0;
          for (; k < tips.length - 1; k++) { acc += tips[k].s; if (p.u < acc) break; }
          const T = tips[k];
          const dx = T.x - p.x, dy = T.y - p.y, d = Math.hypot(dx, dy) || 1;
          const typeF = p.type === 'nucleus' ? 0.55 : p.type === 'food' ? 0.8 : 1;
          // perfil de escoamento: rápido no canal central, parado junto ao tubo de gel
          const prof = clamp((depth - ecto * 0.5) / (ecto * 2.2), 0, 1);
          const sp = U * sol * typeF * Math.min(1, d / 18) * (0.5 + 0.5 * prof);
          tvx = dx / d * sp; tvy = dy / d * sp;
          // fluxo em fonte: perto da calota, desvia para os lados e para dentro
          if (depth < ecto + cap + 10 && ne.tip > 0.2) {
            // lateral = componente de (partícula − ponta) perpendicular ao eixo do braço
            const ax = Math.cos(T.ang), ay = Math.sin(T.ang);
            let lx = p.x - T.x, ly = p.y - T.y; const along = lx * ax + ly * ay;
            lx -= along * ax; ly -= along * ay;
            const ll = Math.hypot(lx, ly) || 1;
            const f = U * 0.9 * ne.tip;
            tvx += lx / ll * f - ne.nx * f * 0.3; tvy += ly / ll * f - ne.ny * f * 0.3;
          }
        }
        const relax = p.gel > 0.5 ? 0.35 : p.type === 'nucleus' ? 0.06 : 0.14;
        p.vx += (tvx - p.vx) * relax; p.vy += (tvy - p.vy) * relax;
        p.x += p.vx; p.y += p.vy;

        if (p.type === 'food') {
          p.digest++;
          if (p.digest >= p.digestMax) {
            parts.splice(pi, 1); this.counts.digested++;
            if (env && env.onDigest) env.onDigest({ x: p.x, y: p.y });
            continue;
          }
          const left = 1 - p.digest / p.digestMax;
          p.r = 2 + 3 * Math.min(1, left * 2.5);
        }
        if (p.gel < 0.3 && (p.type === 'granule' || p.type === 'crystal')) {
          eSum += p.vx * mdx + p.vy * mdy; eN++;
        }
      }
      this.metrics.endoSpeed = eN ? eSum / eN : 0;
      this.metrics.ratio = this.metrics.speed > 0.01 ? this.metrics.endoSpeed / this.metrics.speed : 0;

      this._repel();
      this._contain(env);
    }

    _repel() {
      const P = this.particles, cs = 10, grid = new Map();
      for (let i = 0; i < P.length; i++) {
        const p = P[i], k = ((p.x / cs) | 0) * 73856093 ^ ((p.y / cs) | 0) * 19349663;
        let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
      }
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        const reach = p.type === 'nucleus' ? 2 : 1;
        const gx = (p.x / cs) | 0, gy = (p.y / cs) | 0;
        for (let ox = -reach; ox <= reach; ox++) for (let oy = -reach; oy <= reach; oy++) {
          const a = grid.get(((gx + ox) * 73856093) ^ ((gy + oy) * 19349663));
          if (!a) continue;
          for (const j of a) {
            if (j <= i) continue;
            const q = P[j];
            const dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy, m = p.r + q.r + 0.6;
            if (d2 >= m * m || d2 < 1e-9) continue;
            const d = Math.sqrt(d2), o = (m - d) / d;
            // gel pesa mais (rede de actina); o núcleo empurra o resto
            const wp = (p.type === 'nucleus' ? 0.1 : 1) * (1 - 0.6 * p.gel);
            const wq = (q.type === 'nucleus' ? 0.1 : 1) * (1 - 0.6 * q.gel);
            const ws = wp + wq || 1;
            p.x -= dx * o * wp / ws; p.y -= dy * o * wp / ws;
            q.x += dx * o * wq / ws; q.y += dy * o * wq / ws;
          }
        }
      }
    }

    _contain(env) {
      const P = this.p, ne = {}, obs = env && env.obstacles;
      for (const p of this.particles) {
        this.nearestEdge(p.x, p.y, ne);
        const inside = this.pointInside(p.x, p.y);
        const inset = p.r + 0.8 + P.capDepth * ne.tip * ne.tip * ne.tip + (p.type === 'nucleus' ? 4 : 0);
        if (!inside || ne.d < inset) {
          p.x = ne.px - ne.nx * inset; p.y = ne.py - ne.ny * inset;
          const vn = p.vx * ne.nx + p.vy * ne.ny;
          if (vn > 0) { p.vx -= vn * ne.nx; p.vy -= vn * ne.ny; }
        }
        if (obs) for (const o of obs) {
          const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy), m = o.r + p.r;
          if (d < m && d > 1e-6) { p.x = o.x + dx / d * m; p.y = o.y + dy / d * m; }
        }
      }
    }

    /* ── Fagocitose: presa totalmente envolvida pela membrana vira vacúolo digestivo ── */
    _engulf(env) {
      if (!env || !env.prey) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const nd of this.nodes) { if (nd.x < x0) x0 = nd.x; if (nd.x > x1) x1 = nd.x; if (nd.y < y0) y0 = nd.y; if (nd.y > y1) y1 = nd.y; }
      const ne = {};
      for (const q of env.prey) {
        if (!q.alive || q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
        if (!this.pointInside(q.x, q.y)) continue;
        this.nearestEdge(q.x, q.y, ne);
        if (ne.d < 5) continue;
        q.alive = false;
        this.counts.engulfed++;
        this.particles.push({ type: 'food', x: q.x, y: q.y, vx: 0, vy: 0, r: 5, u: this.rng(),
          gel: 0, phase: 0, digest: 0, digestMax: 900, spin: q.ang || 0 });
        if (env.onEngulf) env.onEngulf(q);
      }
    }
  }

  Amoeba.DEFAULTS = DEFAULTS;
  Amoeba.mulberry32 = mulberry32;
  if (typeof module !== 'undefined' && module.exports) module.exports = Amoeba;
  else root.Amoeba = Amoeba;
})(typeof window !== 'undefined' ? window : globalThis);
