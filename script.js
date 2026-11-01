/*!
 * script.js - user interface, rendering and interaction of TrussLab
 * (2D Truss FEA & Load Simulator). All numerical work is delegated to fea-core.js (global FEA).
 *
 * Internal units are SI base units (m, N, Pa, m^2, m^4). Display/input units are converted
 * only at the UI boundary.
 */
(() => {
  'use strict';

  if (typeof FEA === 'undefined') {
    document.body.innerHTML = '<p style="color:#fff;font:14px sans-serif;padding:2em">fea-core.js failed to load. Keep index.html, script.js, style.css and fea-core.js in the same folder.</p>';
    return;
  }

  /* =====================================================================
   * 1. Small helpers, units and number formatting
   * ===================================================================== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUS = '\u2212';
  const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';
  const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const dpr = () => window.devicePixelRatio || 1;
  const cosSinDeg = FEA.util.cosSinDeg;

  const FORCE_UNITS = { N: 1, kN: 1e3, MN: 1e6 };
  const DISP_UNITS = { 'µm': 1e-6, mm: 1e-3, m: 1 };
  const STIFF_UNITS = { 'N/m': 1, 'kN/m': 1e3, 'MN/m': 1e6 };
  const GPA = 1e9, MPA = 1e6, MM = 1e-3, MM2 = 1e-6, MM4 = 1e-12;
  const fU = () => FORCE_UNITS[S().forceUnit] || 1e3;
  const dU = () => DISP_UNITS[S().dispUnit] || 1e-3;

  /** Engineering number formatting with `sig` significant digits (display only). */
  function fmt(x, sig) {
    sig = sig || S().sig;
    if (x === Infinity) return '\u221E';
    if (x === -Infinity) return MINUS + '\u221E';
    if (typeof x !== 'number' || Number.isNaN(x)) return '\u2014';
    if (x === 0) return '0';
    const ax = Math.abs(x);
    let s;
    if (ax >= 1e-3 && ax < 1e6) {
      const mag = Math.floor(Math.log10(ax));
      s = x.toFixed(clamp(sig - 1 - mag, 0, 12));
    } else {
      s = x.toExponential(Math.max(0, sig - 1));
    }
    return s.replace('e+', 'e').replace('e-', 'e' + MINUS).replace(/^-/, MINUS);
  }
  /** Values at round-off level relative to `ref` are shown as 0 (exports keep raw values). */
  const chop = (x, ref) => (ref > 0 && Math.abs(x) <= 1e-12 * ref ? 0 : x);
  const fF = (N, ref) => fmt(chop(N, ref) / fU());
  const fD = (m, ref) => fmt(chop(m, ref) / dU());
  const fS = (Pa, ref) => fmt(chop(Pa, ref) / MPA);
  /** Value shown inside an input field: 12 significant digits, no trailing zeros. */
  const inVal = (x) => (Number.isFinite(x) ? String(parseFloat(x.toPrecision(12))) : '');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /* ---------- safe arithmetic expression parser for numeric inputs ---------- */
  const D2R = Math.PI / 180;
  const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
    sin: (d) => cosSinDeg(d)[1], cos: (d) => cosSinDeg(d)[0],
    tan: (d) => { const cs = cosSinDeg(d); return cs[1] / cs[0]; },
    asin: (v) => Math.asin(v) / D2R, acos: (v) => Math.acos(v) / D2R, atan: (v) => Math.atan(v) / D2R,
  };
  function parseExpr(src) {
    const s = String(src).trim().replace(/[\u2212\u2013]/g, '-').replace(/\u00D7/g, '*').replace(/\u03C0/g, 'pi').replace(/,/g, '.');
    if (!s) throw new Error('empty');
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const expr = () => {
      let v = term();
      for (;;) { ws(); if (s[i] === '+') { i++; v += term(); } else if (s[i] === '-') { i++; v -= term(); } else return v; }
    };
    const term = () => {
      let v = unary();
      for (;;) { ws(); if (s[i] === '*') { i++; v *= unary(); } else if (s[i] === '/') { i++; v /= unary(); } else return v; }
    };
    const unary = () => { ws(); if (s[i] === '-') { i++; return -unary(); } if (s[i] === '+') { i++; return unary(); } return power(); };
    const power = () => { const b = primary(); ws(); if (s[i] === '^') { i++; return Math.pow(b, unary()); } return b; };
    const primary = () => {
      ws();
      if (s[i] === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') throw new Error('missing )'); i++; return v; }
      const rest = s.slice(i);
      const mn = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest);
      if (mn) { i += mn[0].length; return parseFloat(mn[0]); }
      const mi = /^[a-z_][a-z0-9_]*/i.exec(rest);
      if (mi) {
        const id = mi[0].toLowerCase();
        i += mi[0].length;
        if (id === 'pi') return Math.PI;
        if (id === 'e') return Math.E;
        const f = FUNCS[id];
        if (!f) throw new Error('unknown name ' + id);
        ws(); if (s[i] !== '(') throw new Error('( expected');
        i++; const v = expr(); ws(); if (s[i] !== ')') throw new Error('missing )'); i++;
        return f(v);
      }
      throw new Error('unexpected ' + (s[i] || 'end'));
    };
    const v = expr(); ws();
    if (i < s.length) throw new Error('unexpected ' + s[i]);
    return v;
  }
  function evalNum(str) { try { const v = parseExpr(str); return Number.isFinite(v) ? v : NaN; } catch (e) { return NaN; } }

  /* =====================================================================
   * 2. Materials, sections, model objects
   * ===================================================================== */
  const MATERIAL_PRESETS = {
    steel: { name: 'Structural Steel', E: 200e9, fy: 250e6, color: '#94a3b8' },
    aluminum: { name: '6061-T6 Aluminum', E: 68.9e9, fy: 276e6, color: '#cbd5e1' },
    fir: { name: 'Douglas Fir Timber', E: 11e9, fy: 49.9e6, color: '#d6a86b' },
    custom: { name: 'Custom material', E: 100e9, fy: 200e6, color: '#a78bfa' },
  };
  const FIR_NOTE = 'Timber has no yield point: the limit is the clear-wood compressive strength ∥ grain, 12% MC (USDA Wood Handbook, coast Douglas-fir). Graded-lumber design values are much lower.';
  const GROUP_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf', '#facc15', '#f87171', '#60a5fa', '#e879f9'];

  const SHAPES = {
    custom: { label: 'Custom A and I', dims: [] },
    rod: { label: 'Solid round', dims: [['d', 'Diameter d']] },
    chs: { label: 'Circular hollow (CHS)', dims: [['D', 'Outer Ø D'], ['t', 'Wall t']] },
    rect: { label: 'Solid rectangle', dims: [['b', 'Width b'], ['h', 'Depth h']] },
    rhs: { label: 'Rectangular hollow (RHS/SHS)', dims: [['b', 'Width b'], ['h', 'Depth h'], ['t', 'Wall t']] },
  };
  /** Area and minimum (weak-axis) second moment of area of standard shapes (sharp corners). */
  function sectionProps(sh) {
    const P = Math.PI;
    switch (sh && sh.type) {
      case 'rod': return sh.d > 0 ? { A: P * sh.d * sh.d / 4, I: P * sh.d ** 4 / 64 } : null;
      case 'chs': {
        const D = sh.D, t = sh.t;
        if (!(D > 0 && t > 0 && 2 * t <= D)) return null;
        const di = D - 2 * t;
        return { A: P / 4 * (D * D - di * di), I: P / 64 * (D ** 4 - di ** 4) };
      }
      case 'rect': {
        const b = sh.b, h = sh.h;
        if (!(b > 0 && h > 0)) return null;
        return { A: b * h, I: Math.min(b * h ** 3, h * b ** 3) / 12 };
      }
      case 'rhs': {
        const b = sh.b, h = sh.h, t = sh.t;
        if (!(b > 0 && h > 0 && t > 0 && 2 * t < Math.min(b, h))) return null;
        const bi = b - 2 * t, hi = h - 2 * t;
        return { A: b * h - bi * hi, I: Math.min(b * h ** 3 - bi * hi ** 3, h * b ** 3 - hi * bi ** 3) / 12 };
      }
      default: return null;
    }
  }

  let uidSeq = 1;
  const newUid = () => uidSeq++;
  function makeMaterial(key, over) {
    const p = MATERIAL_PRESETS[key] || MATERIAL_PRESETS.custom;
    return Object.assign({ uid: newUid(), preset: MATERIAL_PRESETS[key] ? key : 'custom', name: p.name, E: p.E, fy: p.fy, color: p.color }, over || {});
  }
  function makeGroup(name, material, shape, color, A, I) {
    const g = { uid: newUid(), name, material, shape: Object.assign({ type: 'custom' }, shape || {}), color: color || GROUP_COLORS[0], A: A || 0, I: I || 0 };
    const sp = sectionProps(g.shape);
    if (sp) { g.A = sp.A; g.I = sp.I; } else g.shape = { type: 'custom' };
    return g;
  }
  function makeNode(x, y) {
    return { uid: newUid(), x, y, support: { type: 'none', angle: 0, fixX: false, fixY: false, dx: 0, dy: 0 }, load: { fx: 0, fy: 0 } };
  }
  const makeMember = (n1, n2, group) => ({ uid: newUid(), n1, n2, group });
  function emptyModel(title) {
    const steel = makeMaterial('steel'), alu = makeMaterial('aluminum'), fir = makeMaterial('fir');
    const g = makeGroup('Default: A 2000 mm²', steel, { type: 'custom' }, GROUP_COLORS[0], 2000 * MM2, 2.0e6 * MM4);
    return { title: title || 'Untitled truss', nodes: [], members: [], materials: [steel, alu, fir], groups: [g] };
  }

  const SUPPORT_TYPES = [
    ['none', 'None (free joint)'],
    ['pin', 'Pin (ux = uy = 0)'],
    ['rollerX', 'Roller (uy = 0)'],
    ['rollerY', 'Roller (ux = 0)'],
    ['inclined', 'Inclined roller (un = 0)'],
    ['custom', 'Custom / prescribed δ'],
  ];
  const SUPPORT_SHORT = { none: 'Free', pin: 'Pin', rollerX: 'Roller uy=0', rollerY: 'Roller ux=0', inclined: 'Incl. roller', custom: 'Custom' };
  function setSupport(node, type, angle) {
    const s = node.support;
    s.type = type;
    const reset = (fx, fy, a) => { s.fixX = fx; s.fixY = fy; s.angle = a; s.dx = 0; s.dy = 0; };
    switch (type) {
      case 'pin': reset(true, true, 0); break;
      case 'rollerX': reset(false, true, 0); break;
      case 'rollerY': reset(true, false, 0); break;
      case 'inclined': reset(false, true, Number.isFinite(angle) ? angle : (s.angle || 30)); break;
      case 'custom':
        if (!s.fixX && !s.fixY) { s.fixX = true; s.fixY = true; }
        if (Number.isFinite(angle)) s.angle = angle;
        s.dx = s.dx || 0; s.dy = s.dy || 0;
        break;
      default: s.type = 'none'; reset(false, false, 0);
    }
  }
  const supportDOF = (s) => ({ fixX: !!s.fixX, fixY: !!s.fixY, angle: s.angle || 0, dx: s.fixX ? s.dx || 0 : 0, dy: s.fixY ? s.dy || 0 : 0 });
  function supportText(s) {
    if (s.type === 'inclined') return `Incl. roller ${fmt(s.angle, 4)}°`;
    if (s.type === 'custom') {
      const parts = [];
      if (s.fixX) parts.push(`x′${s.dx ? ' δ' : ''}`);
      if (s.fixY) parts.push(`y′${s.dy ? ' δ' : ''}`);
      return `Custom ${parts.join(',') || 'free'}${s.angle ? ` @${fmt(s.angle, 3)}°` : ''}`;
    }
    return SUPPORT_SHORT[s.type] || 'Free';
  }

  /* ---------- (de)serialisation: SI units, 1-based ids ---------- */
  function serialize(model) {
    const mi = new Map(model.materials.map((m, i) => [m, i + 1]));
    const gi = new Map(model.groups.map((g, i) => [g, i + 1]));
    const ni = new Map(model.nodes.map((n, i) => [n, i + 1]));
    return {
      format: 'trusslab-model', version: 1,
      units: { length: 'm', force: 'N', stress: 'Pa', area: 'm^2', inertia: 'm^4', angle: 'deg' },
      title: model.title,
      materials: model.materials.map((m, i) => ({ id: i + 1, name: m.name, preset: m.preset, E: m.E, fy: m.fy, color: m.color })),
      sections: model.groups.map((g, i) => ({ id: i + 1, name: g.name, material: mi.get(g.material), A: g.A, I: g.I, shape: Object.assign({}, g.shape), color: g.color })),
      nodes: model.nodes.map((n, i) => ({ id: i + 1, x: n.x, y: n.y, support: Object.assign({}, n.support), load: Object.assign({}, n.load) })),
      members: model.members.map((e, i) => ({ id: i + 1, n1: ni.get(e.n1), n2: ni.get(e.n2), section: gi.get(e.group) })),
    };
  }
  function deserialize(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('the file is not a JSON object');
    if (obj.model && Array.isArray(obj.model.nodes)) obj = obj.model; // calculation report files
    if (!Array.isArray(obj.nodes) || !Array.isArray(obj.members)) throw new Error('missing "nodes" or "members" arrays');
    const fin = (v, d) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);
    const matsIn = Array.isArray(obj.materials) && obj.materials.length ? obj.materials : [{ preset: 'steel' }];
    const materials = matsIn.map((m) => {
      const key = MATERIAL_PRESETS[m.preset] ? m.preset : 'custom', p = MATERIAL_PRESETS[key];
      const E = fin(m.E, p.E), fy = fin(m.fy, p.fy);
      return makeMaterial(key, { name: String(m.name || p.name).slice(0, 80), E: E > 0 ? E : p.E, fy: fy > 0 ? fy : p.fy, color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : p.color });
    });
    const secIn = Array.isArray(obj.sections) ? obj.sections : Array.isArray(obj.groups) ? obj.groups : [];
    const groups = secIn.map((g, i) => {
      const mat = materials[fin(g.material, 1) - 1] || materials[0];
      const shIn = g.shape && SHAPES[g.shape.type] ? g.shape : { type: 'custom' };
      const shape = { type: shIn.type };
      for (const [k] of SHAPES[shIn.type].dims) shape[k] = fin(shIn[k], 0);
      const A = fin(g.A, 0), I = fin(g.I, 0);
      const grp = makeGroup(String(g.name || `Section ${i + 1}`).slice(0, 80), mat, shape, /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : GROUP_COLORS[i % GROUP_COLORS.length], A, I);
      if (!(grp.A > 0)) grp.A = 1000 * MM2;
      if (!(grp.I > 0)) grp.I = 1e6 * MM4;
      return grp;
    });
    if (!groups.length) groups.push(makeGroup('Default: A 2000 mm²', materials[0], { type: 'custom' }, GROUP_COLORS[0], 2000 * MM2, 2.0e6 * MM4));
    const nodes = obj.nodes.map((n, i) => {
      const x = fin(n.x, NaN), y = fin(n.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`node ${i + 1} has invalid coordinates`);
      const nd = makeNode(x, y);
      const s = n.support || {};
      const type = SUPPORT_TYPES.some(([k]) => k === s.type) ? s.type : 'none';
      if (type === 'custom') Object.assign(nd.support, { type, fixX: !!s.fixX, fixY: !!s.fixY, angle: fin(s.angle, 0), dx: fin(s.dx, 0), dy: fin(s.dy, 0) });
      else setSupport(nd, type, fin(s.angle, 30));
      nd.load.fx = fin(n.load && n.load.fx, 0);
      nd.load.fy = fin(n.load && n.load.fy, 0);
      return nd;
    });
    const members = obj.members.map((e, k) => {
      const a = nodes[fin(e.n1, 0) - 1], b = nodes[fin(e.n2, 0) - 1];
      if (!a || !b || a === b) throw new Error(`member ${k + 1} references invalid nodes`);
      return makeMember(a, b, groups[fin(e.section !== undefined ? e.section : e.group, 1) - 1] || groups[0]);
    });
    return { title: String(obj.title || 'Imported truss').slice(0, 120), nodes, members, materials, groups };
  }

  /* =====================================================================
   * 3. Example structures
   * ===================================================================== */
  const EXAMPLES = [
    ['pratt', 'Pratt bridge truss, 18 m span (steel)'],
    ['howe', 'Howe bridge truss, 18 m span (buckling check)'],
    ['warren', 'Warren truss, equilateral (6061-T6 aluminum)'],
    ['aframe', 'Two-bar A-frame: closed-form check'],
    ['cantilever', 'Wall-mounted cantilever truss'],
    ['fink', 'Fink roof truss (Douglas fir)'],
    ['inclined', 'Inclined roller support at 30°'],
    ['settlement', 'Two-span truss with 10 mm support settlement'],
    ['mechanism', 'Unstable: panel without diagonal'],
  ];
  function buildExample(key) {
    const M = emptyModel();
    const [steel, alu, fir] = M.materials;
    M.groups = [];
    const N = (x, y) => { const n = makeNode(x, y); M.nodes.push(n); return n; };
    const E = (a, b, g) => { M.members.push(makeMember(a, b, g)); };
    const G = (name, mat, shape, color, A, I) => { const g = makeGroup(name, mat, shape, color, A, I); M.groups.push(g); return g; };
    const load = (n, fx, fy) => { n.load.fx = fx; n.load.fy = fy; };
    const C = GROUP_COLORS;
    switch (key) {
      case 'howe':
      case 'pratt': {
        const howe = key === 'howe';
        M.title = howe ? 'Howe truss: 6 panels × 3 m, h = 3 m, 50 kN panel loads' : 'Pratt truss: 6 panels × 3 m, h = 3 m, 60 kN panel loads';
        const ch = G('Chords: CHS 139.7×6.3', steel, { type: 'chs', D: 139.7 * MM, t: 6.3 * MM }, C[0]);
        const wb = G('Web: CHS 88.9×5.0', steel, { type: 'chs', D: 88.9 * MM, t: 5.0 * MM }, C[1]);
        const B = [], T = [];
        for (let k = 0; k <= 6; k++) B.push(N(3 * k, 0));
        for (let k = 1; k <= 5; k++) T[k] = N(3 * k, 3);
        for (let k = 0; k < 6; k++) E(B[k], B[k + 1], ch);
        for (let k = 1; k < 5; k++) E(T[k], T[k + 1], ch);
        E(B[0], T[1], ch); E(T[5], B[6], ch);
        for (let k = 1; k <= 5; k++) E(B[k], T[k], wb);
        if (howe) { E(B[1], T[2], wb); E(B[2], T[3], wb); E(T[3], B[4], wb); E(T[4], B[5], wb); }
        else { E(T[1], B[2], wb); E(T[2], B[3], wb); E(T[4], B[3], wb); E(T[5], B[4], wb); }
        setSupport(B[0], 'pin'); setSupport(B[6], 'rollerX');
        for (let k = 1; k <= 5; k++) load(B[k], 0, howe ? -50e3 : -60e3);
        break;
      }
      case 'warren': {
        M.title = 'Warren truss: equilateral, 5 × 4 m, 6061-T6 aluminum';
        const ch = G('Chords: CHS 150×8 (Al)', alu, { type: 'chs', D: 150 * MM, t: 8 * MM }, C[0]);
        const wb = G('Diagonals: CHS 120×6 (Al)', alu, { type: 'chs', D: 120 * MM, t: 6 * MM }, C[2]);
        const h = 2 * Math.sqrt(3);
        const B = [], T = [];
        for (let k = 0; k <= 5; k++) B.push(N(4 * k, 0));
        for (let k = 0; k < 5; k++) T.push(N(4 * k + 2, h));
        for (let k = 0; k < 5; k++) E(B[k], B[k + 1], ch);
        for (let k = 0; k < 4; k++) E(T[k], T[k + 1], ch);
        for (let k = 0; k < 5; k++) { E(B[k], T[k], wb); E(T[k], B[k + 1], wb); }
        setSupport(B[0], 'pin'); setSupport(B[5], 'rollerX');
        for (let k = 1; k <= 4; k++) load(B[k], 0, -40e3);
        break;
      }
      case 'aframe': {
        M.title = 'A-frame (3-4-5): exact F = −62.5 kN, uy = −1.953125 mm';
        const g = G('Bar: A 1000 mm², I 1.0e6 mm⁴', steel, { type: 'custom' }, C[0], 1000 * MM2, 1e6 * MM4);
        const a = N(0, 0), b = N(6, 0), c = N(3, 4);
        E(a, c, g); E(b, c, g);
        setSupport(a, 'pin'); setSupport(b, 'pin');
        load(c, 0, -100e3);
        break;
      }
      case 'cantilever': {
        M.title = 'Cantilever truss: 8 m reach, 40 kN tip load';
        const ch = G('Chords: SHS 100×100×5', steel, { type: 'rhs', b: 100 * MM, h: 100 * MM, t: 5 * MM }, C[0]);
        const wb = G('Web: SHS 60×60×4', steel, { type: 'rhs', b: 60 * MM, h: 60 * MM, t: 4 * MM }, C[3]);
        const B = [0, 2, 4, 6, 8].map((x) => N(x, 0));
        const T = [0, 2, 4, 6].map((x) => N(x, 2));
        for (let k = 0; k < 4; k++) E(B[k], B[k + 1], ch);
        for (let k = 0; k < 3; k++) E(T[k], T[k + 1], ch);
        E(T[3], B[4], ch);
        for (let k = 1; k <= 3; k++) E(B[k], T[k], wb);
        for (let k = 0; k < 3; k++) E(B[k], T[k + 1], wb);
        setSupport(B[0], 'pin'); setSupport(T[0], 'pin');
        load(B[4], 0, -40e3);
        break;
      }
      case 'fink': {
        M.title = 'Fink roof truss: 12 m span, 3 m rise, Douglas fir 75×200';
        const g = G('Timber 75×200 (DF)', fir, { type: 'rect', b: 75 * MM, h: 200 * MM }, C[3]);
        const A = N(0, 0), B = N(4, 0), Cc = N(8, 0), D = N(12, 0), Ee = N(3, 1.5), F = N(6, 3), Gg = N(9, 1.5);
        E(A, Ee, g); E(Ee, F, g); E(F, Gg, g); E(Gg, D, g);
        E(A, B, g); E(B, Cc, g); E(Cc, D, g);
        E(Ee, B, g); E(B, F, g); E(F, Cc, g); E(Cc, Gg, g);
        setSupport(A, 'pin'); setSupport(D, 'rollerX');
        load(Ee, 0, -10e3); load(F, 0, -10e3); load(Gg, 0, -10e3);
        break;
      }
      case 'inclined': {
        M.title = 'Inclined roller at 30°: R_B acts normal to the surface';
        const g = G('CHS 88.9×5.0', steel, { type: 'chs', D: 88.9 * MM, t: 5 * MM }, C[0]);
        const a = N(0, 0), b = N(6, 0), c = N(3, 3);
        E(a, b, g); E(a, c, g); E(b, c, g);
        setSupport(a, 'pin'); setSupport(b, 'inclined', 30);
        load(c, 20e3, -50e3);
        break;
      }
      case 'settlement': {
        M.title = 'Two-span truss: middle support settles 10 mm (indeterminate)';
        const ch = G('Chords: CHS 114.3×6.0', steel, { type: 'chs', D: 114.3 * MM, t: 6 * MM }, C[0]);
        const wb = G('Web: CHS 88.9×5.0', steel, { type: 'chs', D: 88.9 * MM, t: 5 * MM }, C[1]);
        const B = [], T = [];
        for (let k = 0; k <= 8; k++) B.push(N(2.5 * k, 0));
        for (let k = 0; k <= 8; k++) T.push(N(2.5 * k, 2.5));
        for (let k = 0; k < 8; k++) { E(B[k], B[k + 1], ch); E(T[k], T[k + 1], ch); }
        for (let k = 0; k <= 8; k++) E(B[k], T[k], wb);
        for (let k = 0; k < 8; k++) { if (k % 4 < 2) E(T[k], B[k + 1], wb); else E(B[k], T[k + 1], wb); }
        setSupport(B[0], 'pin'); setSupport(B[8], 'rollerX');
        Object.assign(B[4].support, { type: 'custom', fixX: false, fixY: true, angle: 0, dx: 0, dy: -10 * MM });
        for (const k of [1, 2, 3, 5, 6, 7]) load(B[k], 0, -20e3);
        break;
      }
      case 'mechanism': {
        M.title = 'Unstable: the middle panel has no diagonal';
        const g = G('CHS 88.9×5.0', steel, { type: 'chs', D: 88.9 * MM, t: 5 * MM }, C[0]);
        const B = [0, 3, 6, 9].map((x) => N(x, 0)), T = [0, 3, 6, 9].map((x) => N(x, 3));
        for (let k = 0; k < 3; k++) { E(B[k], B[k + 1], g); E(T[k], T[k + 1], g); }
        for (let k = 0; k < 4; k++) E(B[k], T[k], g);
        E(B[0], T[1], g); E(B[2], T[3], g);
        setSupport(B[0], 'pin'); setSupport(B[3], 'rollerX');
        load(B[1], 0, -20e3); load(B[2], 0, -20e3);
        break;
      }
      default: return emptyModel();
    }
    return M;
  }

  /* =====================================================================
   * 4. Application state, settings, history, persistence
   * ===================================================================== */
  const DEFAULT_SETTINGS = {
    grid: 0.5, snap: true, snapNodes: true, showGrid: true,
    forceUnit: 'kN', dispUnit: 'mm', sig: 4,
    loadFactor: 1, targetSF: 1.5,
    scale: 100, autoScale: true, colorBy: 'force',
    showUndeformed: true, showDeformed: true, showLoads: true, showReactions: true, showSupports: true,
    showNodeLabels: true, showMemberLabels: false, showForceLabels: false, animate: true,
    liveSolve: true, chain: true,
    bottomTab: 'members', bottomCollapsed: false, bottomHeight: 250,
    mtxView: 'global', mtxUnit: 'kN/m', mtxMode: 'table', mtxDimZeros: true,
  };
  const state = {
    model: null,
    s: Object.assign({}, DEFAULT_SETTINGS),
    view: { cx: 9, cy: 1.5, zoom: 40 },
    tool: 'select',
    sel: { nodes: new Set(), members: new Set() },
    hover: null, tableHover: null,
    pointer: { sx: 0, sy: 0, inside: false },
    drag: null, memberStart: null, spaceDown: false,
    res: null, stale: true,
    activeGroup: null, editGroup: null,
    anim: { start: 0, dur: 750, p: 1 },
    mechMode: 0, mechT0: 0,
    supTool: { type: 'pin', angle: 30 },
    loadTool: { fx: 0, fy: -10e3, mode: 'set' },
    sort: { members: { key: 'id', dir: 1 }, nodes: { key: 'id', dir: 1 } },
    lastP: null, W: 0, H: 0,
  };
  function S() { return state.s; }

  const history = { undo: [], redo: [], max: 200 };
  const snapshot = () => JSON.stringify(serialize(state.model));
  function pushUndo(snap) {
    history.undo.push(snap || snapshot());
    if (history.undo.length > history.max) history.undo.shift();
    history.redo.length = 0;
    updateUndoButtons();
  }
  function restoreSnapshot(str) {
    const gi = state.model.groups.indexOf(state.activeGroup);
    const ei = state.model.groups.indexOf(state.editGroup);
    state.model = deserialize(JSON.parse(str));
    state.activeGroup = state.model.groups[gi] || state.model.groups[0];
    state.editGroup = ei >= 0 ? state.model.groups[ei] || null : null;
    state.memberStart = null;
    clearSelection(false);
    modelChanged({ groups: true, materials: true });
  }
  function undo() {
    if (!history.undo.length) { toast('Nothing to undo'); return; }
    history.redo.push(snapshot());
    restoreSnapshot(history.undo.pop());
    updateUndoButtons();
  }
  function redo() {
    if (!history.redo.length) { toast('Nothing to redo'); return; }
    history.undo.push(snapshot());
    restoreSnapshot(history.redo.pop());
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('#btnUndo').disabled = !history.undo.length;
    $('#btnRedo').disabled = !history.redo.length;
  }

  const STORE_KEY = 'trusslab.session.v1';
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const keep = {};
        for (const k of Object.keys(DEFAULT_SETTINGS)) keep[k] = state.s[k];
        localStorage.setItem(STORE_KEY, JSON.stringify({ model: serialize(state.model), settings: keep, view: state.view }));
      } catch (e) { /* storage unavailable or full: ignore */ }
    }, 400);
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      const model = deserialize(obj.model);
      if (obj.settings) for (const k of Object.keys(DEFAULT_SETTINGS)) if (obj.settings[k] !== undefined && typeof obj.settings[k] === typeof DEFAULT_SETTINGS[k]) state.s[k] = obj.settings[k];
      if (!FORCE_UNITS[state.s.forceUnit]) state.s.forceUnit = 'kN';
      if (!DISP_UNITS[state.s.dispUnit]) state.s.dispUnit = 'mm';
      if (obj.view && Number.isFinite(obj.view.zoom) && obj.view.zoom > 0) state.view = { cx: +obj.view.cx || 0, cy: +obj.view.cy || 0, zoom: obj.view.zoom };
      state.model = model;
      return true;
    } catch (e) { return false; }
  }

  /* =====================================================================
   * 5. Analysis driver
   * ===================================================================== */
  function buildInput() {
    const m = state.model, lf = state.s.loadFactor;
    const idx = new Map(m.nodes.map((n, i) => [n, i]));
    return {
      nodes: m.nodes.map((n) => Object.assign({ x: n.x, y: n.y, fx: n.load.fx * lf, fy: n.load.fy * lf }, supportDOF(n.support))),
      members: m.members.map((e) => ({ i: idx.get(e.n1), j: idx.get(e.n2), E: e.group.material.E, A: e.group.A, I: e.group.I, fy: e.group.material.fy })),
      options: { targetSF: state.s.targetSF },
    };
  }

  let solveQueued = false;
  function requestSolve() {
    state.stale = true;
    if (!state.s.liveSolve) { refreshStatus(); return; }
    if (solveQueued) return;
    solveQueued = true;
    requestAnimationFrame(() => { solveQueued = false; solve(false); });
  }
  function solve(animate) {
    let r;
    const t0 = performance.now();
    try { r = FEA.analyze(buildInput()); }
    catch (err) {
      console.error(err);
      r = { ok: false, stage: 'error', errors: [{ msg: 'Internal solver error: ' + err.message }], warnings: [], log: [], members: [], nodes: [], diagnostics: {} };
    }
    r.wall = performance.now() - t0;
    r.nodeObjs = state.model.nodes.slice();
    r.memberObjs = state.model.members.slice();
    r.nodeIndex = new Map(r.nodeObjs.map((n, i) => [n, i]));
    r.memberIndex = new Map(r.memberObjs.map((e, i) => [e, i]));
    r.loadFactor = state.s.loadFactor;
    state.res = r;
    state.stale = false;
    if (r.ok && state.s.autoScale) autoScale();
    if (r.mechanism) { state.mechMode = clamp(state.mechMode, 0, r.mechanism.modes.length - 1); if (!state.mechT0) state.mechT0 = performance.now(); }
    else state.mechT0 = 0;
    if (animate && r.ok && state.s.animate) { state.anim.start = performance.now(); state.anim.p = 0; }
    refreshResults();
    requestRender();
  }
  /** Results that belong to the current model (or are being refreshed live). */
  function R() {
    const r = state.res;
    if (!r) return null;
    if (state.stale && !state.s.liveSolve) return null;
    return r;
  }
  const nodeRes = (r, n) => { const i = r && r.ok ? r.nodeIndex.get(n) : undefined; return i === undefined ? null : r.nodes[i]; };
  const memberRes = (r, e) => { const i = r && r.ok ? r.memberIndex.get(e) : undefined; return i === undefined ? null : r.members[i]; };
  const nodeNo = (n) => state.model.nodes.indexOf(n) + 1;
  const memberNo = (e) => state.model.members.indexOf(e) + 1;

  function autoScale() {
    const r = state.res;
    if (!r || !r.ok) return;
    const umax = r.summary.maxDisp.value, ext = modelExtent();
    if (!(umax > 0) || !(ext > 0)) return;
    let s = clamp(0.08 * ext / umax, 1, 1000);
    const p = Math.pow(10, Math.floor(Math.log10(s)) - 1);
    s = Math.max(1, Math.round(s / p) * p);
    state.s.scale = parseFloat(s.toPrecision(2));
    syncScaleUI();
  }

  /* =====================================================================
   * 6. View transform, snapping, picking
   * ===================================================================== */
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const viewport = $('#viewport');

  const w2s = (x, y) => [(x - state.view.cx) * state.view.zoom + state.W / 2, state.H / 2 - (y - state.view.cy) * state.view.zoom];
  const s2w = (sx, sy) => [(sx - state.W / 2) / state.view.zoom + state.view.cx, state.view.cy - (sy - state.H / 2) / state.view.zoom];

  function modelBounds() {
    const ns = state.model.nodes;
    if (!ns.length) return null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const n of ns) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
    return { x0, x1, y0, y1 };
  }
  function modelExtent() { const b = modelBounds(); return b ? Math.max(b.x1 - b.x0, b.y1 - b.y0) : 0; }
  function fitView() {
    const b = modelBounds();
    if (!b || !state.W) { state.view = { cx: 5, cy: 2, zoom: 40 }; requestRender(); updateZoomLabel(); return; }
    const w = Math.max(b.x1 - b.x0, 1), h = Math.max(b.y1 - b.y0, 1);
    // margins leave room for support glyphs, reaction labels, the HUD and the legend
    const padX = Math.min(175, state.W * 0.2), padTop = Math.min(105, state.H * 0.2), padBot = Math.min(150, state.H * 0.28);
    const zx = (state.W - 2 * padX) / w, zy = (state.H - padTop - padBot) / h;
    state.view.zoom = clamp(Math.min(zx, zy), 2, 5000);
    state.view.cx = (b.x0 + b.x1) / 2;
    state.view.cy = (b.y0 + b.y1) / 2 - ((padBot - padTop) / 2) / state.view.zoom;
    updateZoomLabel();
    requestRender();
    scheduleSave();
  }
  function zoomAt(factor, sx, sy) {
    const [wx, wy] = s2w(sx, sy);
    state.view.zoom = clamp(state.view.zoom * factor, 1, 20000);
    state.view.cx = wx - (sx - state.W / 2) / state.view.zoom;
    state.view.cy = wy + (sy - state.H / 2) / state.view.zoom;
    updateZoomLabel();
    requestRender();
    scheduleSave();
  }
  function updateZoomLabel() { $('#zoomLabel').textContent = `${fmt(state.view.zoom, 3)} px/m`; }

  /** Grid step as an exact rational num/den so snapped coordinates are the doubles nearest to k*step. */
  function gridFrac() {
    const g = state.s.grid;
    for (const den of [1, 2, 4, 5, 10, 20, 100]) { const num = Math.round(g * den); if (Math.abs(num / den - g) < 1e-12) return [num, den]; }
    return [g, 1];
  }
  function snapCoord(v) { const [num, den] = gridFrac(); return (Math.round(v * den / num) * num) / den; }
  function onGrid(v) { return Math.abs(v - snapCoord(v)) < 1e-9; }
  /** Resolve a screen position to a model point: existing node, grid point or free point. */
  function resolvePoint(sx, sy, exclude) {
    if (state.s.snapNodes) {
      const hit = pickNode(sx, sy, 10, exclude, true);
      if (hit) return { node: hit, x: hit.x, y: hit.y };
    }
    let [x, y] = s2w(sx, sy);
    if (state.s.snap) { x = snapCoord(x); y = snapCoord(y); }
    const tol = 1e-9 * Math.max(1, modelExtent());
    for (const n of state.model.nodes) if (n !== exclude && Math.abs(n.x - x) <= tol && Math.abs(n.y - y) <= tol) return { node: n, x: n.x, y: n.y };
    return { node: null, x, y };
  }

  /** World position at which a node is drawn (deformed shape, mechanism animation or model). */
  function displayInfo(now) {
    const r = R();
    const info = { mode: 'model', factor: 0, r };
    if (r && r.ok && state.s.showDeformed) { info.mode = 'deformed'; info.factor = state.s.scale * state.anim.p; }
    else if (r && !r.ok && r.mechanism && r.mechanism.modes.length) {
      const amp = 0.06 * Math.max(modelExtent(), 1);
      info.mode = 'mechanism';
      info.factor = amp * Math.sin(((now || performance.now()) - state.mechT0) / 1000 * 2.6);
      info.modeVec = r.mechanism.modes[state.mechMode].u;
    }
    return info;
  }
  function dispPos(n, info) {
    if (info.mode === 'deformed') {
      const nr = nodeRes(info.r, n);
      if (nr) return [n.x + nr.ux * info.factor, n.y + nr.uy * info.factor];
    } else if (info.mode === 'mechanism') {
      const i = info.r.nodeIndex.get(n);
      if (i !== undefined) return [n.x + info.modeVec[2 * i] * info.factor, n.y + info.modeVec[2 * i + 1] * info.factor];
    }
    return [n.x, n.y];
  }
  function pickNode(sx, sy, rad, exclude, modelOnly) {
    const info = displayInfo();
    let best = null, bd = rad * rad;
    for (const n of state.model.nodes) {
      if (n === exclude) continue;
      const cands = [[n.x, n.y]];
      if (!modelOnly && info.mode !== 'model') cands.push(dispPos(n, info));
      for (const [x, y] of cands) {
        const [px, py] = w2s(x, y);
        const d = (px - sx) ** 2 + (py - sy) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
    }
    return best;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
    t = clamp(t, 0, 1);
    return (px - ax - t * vx) ** 2 + (py - ay - t * vy) ** 2;
  }
  function pickMember(sx, sy, tol) {
    const info = displayInfo();
    let best = null, bd = tol * tol;
    for (const e of state.model.members) {
      const sets = [[[e.n1.x, e.n1.y], [e.n2.x, e.n2.y]]];
      if (info.mode !== 'model') sets.push([dispPos(e.n1, info), dispPos(e.n2, info)]);
      for (const [a, b] of sets) {
        const [ax, ay] = w2s(a[0], a[1]), [bx, by] = w2s(b[0], b[1]);
        const d = segDist2(sx, sy, ax, ay, bx, by);
        if (d < bd) { bd = d; best = e; }
      }
    }
    return best;
  }
  function pick(sx, sy) {
    const n = pickNode(sx, sy, 9);
    if (n) return { kind: 'node', obj: n };
    const e = pickMember(sx, sy, 6);
    if (e) return { kind: 'member', obj: e };
    return null;
  }

  /* =====================================================================
   * 7. Rendering
   * ===================================================================== */
  const COL = {
    bg: '#0b1118', gridMinor: '#141d29', gridMajor: '#1d2a3b', axis: '#34465f', gridText: '#4b5b70',
    member: '#a9b8cb', ghost: '#3d4b5e', node: '#e2e8f0', nodeStroke: '#0b1118',
    sel: '#fbbf24', hover: '#38bdf8', support: '#8fa3bb', custom: '#a78bfa', load: '#fbbf24', reaction: '#34d399',
    tension: [59, 130, 246], compression: [239, 68, 68], zero: [107, 114, 128], mech: '#fbbf24', fail: '#f87171',
  };
  let renderQueued = false;
  function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(frame); } }
  function frame(now) {
    renderQueued = false;
    if (state.anim.p < 1) {
      const t = clamp((now - state.anim.start) / state.anim.dur, 0, 1);
      state.anim.p = 1 - Math.pow(1 - t, 3);
      if (t >= 1) state.anim.p = 1;
    }
    draw(now);
    const r = R();
    if (state.anim.p < 1 || (r && !r.ok && r.mechanism)) requestRender();
  }
  function resizeCanvas() {
    const rect = viewport.getBoundingClientRect();
    state.W = Math.max(1, Math.floor(rect.width));
    state.H = Math.max(1, Math.floor(rect.height));
    const k = dpr();
    canvas.width = Math.round(state.W * k);
    canvas.height = Math.round(state.H * k);
    requestRender();
  }

  function mix(c0, c1, t) { return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * t)},${Math.round(c0[1] + (c1[1] - c0[1]) * t)},${Math.round(c0[2] + (c1[2] - c0[2]) * t)})`; }
  /** Member colour: blue tension, red compression, grey zero-force; intensity ∝ |value| / max. */
  function memberColor(mr, scaleMax) {
    if (!mr || mr.state === 'zero') return mix(COL.zero, COL.zero, 0);
    const v = colorValue(mr);
    const t = scaleMax > 0 ? clamp(Math.abs(v) / scaleMax, 0, 1) : 1;
    return mix(COL.zero, mr.force > 0 ? COL.tension : COL.compression, 0.35 + 0.65 * Math.sqrt(t));
  }
  function colorValue(mr) {
    switch (state.s.colorBy) {
      case 'stress': return mr.stress;
      case 'util': return Math.sign(mr.force) * mr.utilization;
      default: return mr.force;
    }
  }
  function colorScaleMax(r) {
    if (state.s.colorBy === 'util') return 1;
    let m = 0;
    for (const mr of r.members) if (mr.state !== 'zero') m = Math.max(m, Math.abs(colorValue(mr)));
    return m;
  }

  function draw(now) {
    const k = dpr();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, state.W, state.H);
    if (state.s.showGrid) drawGrid();
    drawAxisTriad();

    const info = displayInfo(now);
    const r = info.r;
    const M = state.model;
    const showRes = info.mode === 'deformed';
    const P = new Map();
    for (const n of M.nodes) P.set(n, w2s(...dispPos(n, info)));
    const O = new Map();
    for (const n of M.nodes) O.set(n, w2s(n.x, n.y));
    const hoverObj = (state.hover && state.hover.obj) || state.tableHover;

    // undeformed ghost
    if (info.mode !== 'model' && state.s.showUndeformed) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = COL.ghost;
      ctx.beginPath();
      for (const e of M.members) { const a = O.get(e.n1), b = O.get(e.n2); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
      ctx.restore();
    }

    const scaleMax = showRes ? colorScaleMax(r) : 0;
    const mechNodes = info.mode === 'mechanism' ? new Set(r.mechanism.modes[state.mechMode].nodes.map((i) => r.nodeObjs[i])) : null;

    // selection / hover underlay
    for (const e of M.members) {
      const sel = state.sel.members.has(e), hov = hoverObj === e;
      if (!sel && !hov) continue;
      const a = P.get(e.n1), b = P.get(e.n2);
      ctx.strokeStyle = sel ? 'rgba(251,191,36,0.55)' : 'rgba(56,189,248,0.45)';
      ctx.lineWidth = 9; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    // members
    ctx.lineCap = 'round';
    for (const e of M.members) {
      const a = P.get(e.n1), b = P.get(e.n2);
      const mr = showRes ? memberRes(r, e) : null;
      let color = COL.member, width = 2.6;
      if (showRes && mr) { color = memberColor(mr, scaleMax); width = 3.2; }
      else if (info.mode === 'mechanism') { color = mechNodes.has(e.n1) || mechNodes.has(e.n2) ? COL.mech : '#6b7a8f'; }
      if (mr && mr.status !== 'safe') {
        ctx.strokeStyle = 'rgba(248,113,113,0.28)'; ctx.lineWidth = 11;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.setLineDash(mr && mr.state === 'zero' ? [6, 4] : []);
      ctx.beginPath();
      if (mr && mr.status === 'buckled') { // bowed shape for buckled members
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const bow = Math.min(10, L * 0.08);
        ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(mx - dy / L * bow * 2, my + dx / L * bow * 2, b[0], b[1]);
      } else { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (state.s.showSupports) for (const n of M.nodes) if (n.support.type !== 'none') drawSupport(n, O.get(n));
    if (showRes && state.s.showReactions) drawReactions(r, P);
    if (state.s.showLoads) drawLoads(P);

    // nodes
    for (const n of M.nodes) {
      const [x, y] = P.get(n);
      const sel = state.sel.nodes.has(n), hov = hoverObj === n, start = state.memberStart && state.memberStart.node === n;
      if (sel || hov || start) {
        ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = sel ? COL.sel : start ? COL.reaction : COL.hover; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = mechNodes && mechNodes.has(n) ? COL.mech : COL.node;
      ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = COL.nodeStroke; ctx.stroke();
      if (info.mode !== 'model' && state.s.showUndeformed) {
        const [ox, oy] = O.get(n);
        if (Math.hypot(ox - x, oy - y) > 3) { ctx.beginPath(); ctx.arc(ox, oy, 2.6, 0, Math.PI * 2); ctx.strokeStyle = COL.ghost; ctx.lineWidth = 1.2; ctx.stroke(); }
      }
    }
    drawLabels(P, r, showRes);
    drawToolOverlay(info);
    updateHud(info);
  }

  function drawGrid() {
    const z = state.view.zoom;
    let minor = state.s.grid;
    const mults = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    for (const f of mults) { if (state.s.grid * f * z >= 9) { minor = state.s.grid * f; break; } }
    let major = minor * 5;
    for (const c of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) { if (c >= minor * 4 - 1e-12) { major = c; break; } }
    const [x0, y1] = s2w(0, 0), [x1, y0] = s2w(state.W, state.H);
    const lines = (step, color) => {
      ctx.beginPath();
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      for (let i = Math.ceil(x0 / step); i * step <= x1; i++) { const sx = Math.round(w2s(i * step, 0)[0]) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, state.H); }
      for (let j = Math.ceil(y0 / step); j * step <= y1; j++) { const sy = Math.round(w2s(0, j * step)[1]) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(state.W, sy); }
      ctx.stroke();
    };
    lines(minor, COL.gridMinor);
    lines(major, COL.gridMajor);
    const [ax, ay] = w2s(0, 0);
    ctx.beginPath(); ctx.strokeStyle = COL.axis; ctx.lineWidth = 1;
    ctx.moveTo(Math.round(ax) + 0.5, 0); ctx.lineTo(Math.round(ax) + 0.5, state.H);
    ctx.moveTo(0, Math.round(ay) + 0.5); ctx.lineTo(state.W, Math.round(ay) + 0.5);
    ctx.stroke();
    ctx.fillStyle = COL.gridText; ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const lab = (v) => String(parseFloat(v.toPrecision(10)));
    for (let i = Math.ceil(x0 / major); i * major <= x1; i++) { const sx = w2s(i * major, 0)[0]; if (sx > 30) ctx.fillText(lab(i * major), sx, state.H - 4); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let j = Math.ceil(y0 / major); j * major <= y1; j++) { const sy = w2s(0, j * major)[1]; if (sy < state.H - 20) ctx.fillText(lab(j * major), 4, sy); }
  }
  function drawAxisTriad() {
    const x = 26, y = state.H - 50;
    ctx.save();
    ctx.lineWidth = 1.5; ctx.font = `10px ${MONO}`; ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#e57373'; ctx.fillStyle = '#e57373'; arrow(x, y, x + 26, y, 6); ctx.fillText('x', x + 31, y);
    ctx.strokeStyle = '#81c784'; ctx.fillStyle = '#81c784'; arrow(x, y, x, y - 26, 6); ctx.textAlign = 'center'; ctx.fillText('y', x, y - 33);
    ctx.restore();
  }
  function arrow(x0, y0, x1, y1, head) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(a - 0.42), y1 - head * Math.sin(a - 0.42));
    ctx.lineTo(x1 - head * Math.cos(a + 0.42), y1 - head * Math.sin(a + 0.42));
    ctx.closePath(); ctx.fill();
  }
  /** Support glyph drawn in a frame rotated by `deg` (world CCW), apex at the node. */
  function drawSupport(n, at) {
    const s = n.support;
    let deg = 0, kind = 'pin';
    switch (s.type) {
      case 'pin': kind = 'pin'; break;
      case 'rollerX': kind = 'roller'; break;
      case 'rollerY': kind = 'roller'; deg = -90; break;
      case 'inclined': kind = 'roller'; deg = s.angle; break;
      case 'custom':
        if (s.fixX && s.fixY) { kind = 'pin'; deg = s.angle; }
        else if (s.fixY) { kind = 'roller'; deg = s.angle; }
        else if (s.fixX) { kind = 'roller'; deg = s.angle - 90; }
        else return;
        break;
      default: return;
    }
    const [c, sn] = cosSinDeg(deg);
    const T = (lx, ly) => [at[0] + lx * c - ly * sn, at[1] - (lx * sn + ly * c)];
    const color = s.type === 'custom' ? COL.custom : COL.support;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = 'rgba(143,163,187,0.12)'; ctx.lineWidth = 1.5;
    const h = 13, w = 9;
    ctx.beginPath();
    let p = T(0, -4); ctx.moveTo(p[0], p[1]);
    p = T(-w, -h); ctx.lineTo(p[0], p[1]);
    p = T(w, -h); ctx.lineTo(p[0], p[1]);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    let base = -h;
    if (kind === 'roller') {
      for (const lx of [-5, 5]) { const q = T(lx, -h - 3.2); ctx.beginPath(); ctx.arc(q[0], q[1], 3, 0, Math.PI * 2); ctx.stroke(); }
      base = -h - 6.6;
    }
    ctx.beginPath();
    p = T(-w - 5, base); ctx.moveTo(p[0], p[1]); p = T(w + 5, base); ctx.lineTo(p[0], p[1]);
    for (let lx = -w - 3; lx <= w + 5; lx += 4.5) { const a = T(lx, base), b = T(lx - 4, base - 5); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.stroke();
    if (s.type === 'custom' && (s.dx || s.dy)) {
      ctx.fillStyle = COL.custom; ctx.font = `bold 11px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const q = T(w + 8, -h / 2);
      ctx.fillText('δ', q[0], q[1]);
    }
    ctx.restore();
  }
  function drawLoads(P) {
    const lf = state.s.loadFactor;
    let fmax = 0;
    for (const n of state.model.nodes) fmax = Math.max(fmax, Math.hypot(n.load.fx, n.load.fy));
    if (!(fmax > 0)) return;
    ctx.save();
    ctx.strokeStyle = COL.load; ctx.fillStyle = COL.load; ctx.lineWidth = 2;
    ctx.font = `11px ${MONO}`;
    for (const n of state.model.nodes) {
      const fx = n.load.fx * lf, fy = n.load.fy * lf, F = Math.hypot(fx, fy);
      if (!(F > 0)) continue;
      const len = 26 + 34 * Math.hypot(n.load.fx, n.load.fy) / fmax;
      const ux = fx / F, uy = -fy / F;
      const [x, y] = P.get(n);
      const hx = x - ux * 7, hy = y - uy * 7, tx = hx - ux * len, ty = hy - uy * len;
      arrow(tx, ty, hx, hy, 8);
      const label = fx !== 0 && fy !== 0 ? `${fmt(F / fU(), 3)} ${state.s.forceUnit} ∠${fmt(Math.atan2(fy, fx) / D2R, 3)}°` : `${fmt(F / fU(), 3)} ${state.s.forceUnit}`;
      tag(label, tx - ux * 4, ty - uy * 4, ux > 0.3 ? 'right' : ux < -0.3 ? 'left' : 'center', uy > 0.3 ? 'bottom' : uy < -0.3 ? 'top' : 'middle', COL.load);
    }
    ctx.restore();
  }
  /** Text label on a dark plate for legibility over members and grid. */
  function tag(text, x, y, align, baseline, color) {
    ctx.textAlign = align; ctx.textBaseline = baseline;
    const w = ctx.measureText(text).width;
    const bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const by = baseline === 'bottom' ? y - 14 : baseline === 'top' ? y - 2 : y - 8;
    ctx.fillStyle = 'rgba(11,17,24,0.8)';
    ctx.fillRect(bx - 3, by, w + 6, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
  function drawReactions(r, P) {
    ctx.save();
    ctx.strokeStyle = COL.reaction; ctx.fillStyle = COL.reaction; ctx.lineWidth = 2;
    ctx.font = `11px ${MONO}`;
    const ref = r.summary.Fref;
    for (const n of state.model.nodes) {
      const nr = nodeRes(r, n);
      if (!nr || !(nr.restrained[0] || nr.restrained[1])) continue;
      const [c, s] = nr.frame;
      const axes = [[c, s, nr.rLocal[0], nr.restrained[0], 0], [-s, c, nr.rLocal[1], nr.restrained[1], 1]];
      const [x, y] = P.get(n);
      for (const [ex, ey, val, fixed, ax] of axes) {
        if (!fixed || Math.abs(val) <= 1e-9 * ref) continue;
        const sg = Math.sign(val), ux = ex * sg, uy = -ey * sg;
        const hx = x - ux * 8, hy = y - uy * 8, len = 40, tx = hx - ux * len, ty = hy - uy * len;
        arrow(tx, ty, hx, hy, 8);
        const name = nr.rotated ? (n.support.type === 'inclined' ? 'Rn' : ax ? 'Ry′' : 'Rx′') : ax ? 'Ry' : 'Rx';
        const label = `${name} = ${fF(val, ref)} ${state.s.forceUnit}`;
        // horizontal arrows: label below the shaft so it does not hide the arrow
        tag(label, tx - ux * 4, ty - uy * 4 + (Math.abs(ux) > 0.9 ? 11 : 0),
          ux > 0.3 ? 'right' : ux < -0.3 ? 'left' : 'center', uy > 0.3 ? 'bottom' : uy < -0.3 ? 'top' : 'middle', COL.reaction);
      }
    }
    ctx.restore();
  }
  function drawLabels(P, r, showRes) {
    const M = state.model;
    ctx.save();
    ctx.font = `10.5px ${MONO}`;
    if (state.s.showNodeLabels) {
      ctx.fillStyle = '#8fa3bb'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      M.nodes.forEach((n, i) => { const [x, y] = P.get(n); ctx.fillText(`N${i + 1}`, x + 6, y - 5); });
    }
    if (state.s.showMemberLabels || (state.s.showForceLabels && showRes)) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      M.members.forEach((e, k) => {
        const a = P.get(e.n1), b = P.get(e.n2);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const parts = [];
        if (state.s.showMemberLabels) parts.push(`M${k + 1}`);
        const mr = showRes ? memberRes(r, e) : null;
        if (state.s.showForceLabels && mr) parts.push(mr.state === 'zero' ? '0' : fF(mr.force, r.summary.Fref));
        if (!parts.length) return;
        const t = parts.join(' · ');
        const w = ctx.measureText(t).width + 8;
        ctx.fillStyle = 'rgba(11,17,24,0.85)';
        ctx.fillRect(mx - w / 2, my - 8, w, 16);
        ctx.fillStyle = mr ? (mr.state === 'zero' ? '#94a3b8' : mr.force > 0 ? '#93c5fd' : '#fca5a5') : '#8fa3bb';
        ctx.fillText(t, mx, my);
      });
    }
    ctx.restore();
  }
  function drawToolOverlay(info) {
    const p = state.pointer;
    if (state.drag && state.drag.type === 'box') {
      const d = state.drag;
      ctx.save();
      ctx.fillStyle = 'rgba(56,189,248,0.08)'; ctx.strokeStyle = 'rgba(56,189,248,0.7)'; ctx.setLineDash([4, 3]);
      ctx.fillRect(d.x0, d.y0, p.sx - d.x0, p.sy - d.y0); ctx.strokeRect(d.x0 + 0.5, d.y0 + 0.5, p.sx - d.x0, p.sy - d.y0);
      ctx.restore();
    }
    if (!p.inside) return;
    if (state.tool === 'node' || state.tool === 'member') {
      const pt = resolvePoint(p.sx, p.sy);
      const [x, y] = w2s(pt.x, pt.y);
      ctx.save();
      ctx.strokeStyle = pt.node ? COL.reaction : COL.hover; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
      if (pt.node) { ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
      if (state.tool === 'member' && state.memberStart) {
        const st = state.memberStart;
        const [sx, sy] = st.node ? w2s(st.node.x, st.node.y) : w2s(st.x, st.y);
        ctx.setLineDash([6, 4]); ctx.strokeStyle = COL.hover; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(x, y); ctx.stroke();
        if (!st.node) { ctx.setLineDash([]); ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.stroke(); }
        const x0 = st.node ? st.node.x : st.x, y0 = st.node ? st.node.y : st.y;
        const L = Math.hypot(pt.x - x0, pt.y - y0), ang = Math.atan2(pt.y - y0, pt.x - x0) / D2R;
        ctx.setLineDash([]);
        ctx.font = `11px ${MONO}`; ctx.fillStyle = '#cfe8fb'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`L = ${fmt(L, 5)} m  θ = ${fmt(ang, 4)}°`, x + 12, y + 10);
      } else {
        ctx.font = `11px ${MONO}`; ctx.fillStyle = '#8fb3cc'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`(${fmt(pt.x, 6)}, ${fmt(pt.y, 6)})`, x + 12, y + 10);
      }
      ctx.restore();
    }
    if (state.drag && state.drag.type === 'move' && state.drag.moved && state.drag.anchor) {
      const n = state.drag.anchor, [x, y] = w2s(n.x, n.y);
      ctx.save(); ctx.font = `11px ${MONO}`; ctx.fillStyle = '#fde68a'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`(${fmt(n.x, 6)}, ${fmt(n.y, 6)}) m`, x + 12, y + 10); ctx.restore();
    }
  }
  function updateHud(info) {
    const r = info.r;
    const lines = [];
    if (info.mode === 'deformed') lines.push(`<b>Deflection ×${fmt(state.s.scale, 4)}</b> · dashed = undeformed`);
    if (state.s.loadFactor !== 1) lines.push(`<b>Load factor λ = ${fmt(state.s.loadFactor, 4)}</b>`);
    if (r && r.ok) lines.push(`δmax ${fD(r.summary.maxDisp.value)} ${state.s.dispUnit} · SFmin ${fmt(r.summary.minSF.value, 3)}`);
    const html = lines.join('<br>');
    const hud = $('#hud');
    if (hud.innerHTML !== html) hud.innerHTML = html;
  }

  /* =====================================================================
   * 8. Editing operations
   * ===================================================================== */
  function modelChanged(o) {
    o = o || {};
    state.res && (state.stale = true);
    if (o.groups || o.materials) renderLeftLists();
    if (!o.keepInspector) renderInspector();
    scheduleSave();
    requestSolve();
    requestRender();
    refreshCounts();
    if (!state.s.liveSolve) refreshResults();
  }
  function clearSelection(render = true) {
    state.sel.nodes.clear(); state.sel.members.clear();
    if (render) { renderInspector(); renderTablesIfVisible(); requestRender(); }
  }
  function selectOnly(kind, obj) {
    state.sel.nodes.clear(); state.sel.members.clear();
    if (obj) (kind === 'node' ? state.sel.nodes : state.sel.members).add(obj);
    renderInspector(); renderTablesIfVisible(); requestRender();
  }
  function toggleSel(kind, obj) {
    const set = kind === 'node' ? state.sel.nodes : state.sel.members;
    set.has(obj) ? set.delete(obj) : set.add(obj);
    renderInspector(); renderTablesIfVisible(); requestRender();
  }
  function selectAll() {
    state.model.nodes.forEach((n) => state.sel.nodes.add(n));
    state.model.members.forEach((e) => state.sel.members.add(e));
    renderInspector(); renderTablesIfVisible(); requestRender();
  }
  function findMember(a, b) { return state.model.members.find((e) => (e.n1 === a && e.n2 === b) || (e.n1 === b && e.n2 === a)); }
  function addNodeAt(x, y, undoable = true) {
    const tol = 1e-9 * Math.max(1, modelExtent());
    const ex = state.model.nodes.find((n) => Math.abs(n.x - x) <= tol && Math.abs(n.y - y) <= tol);
    if (ex) return { node: ex, created: false };
    if (undoable) pushUndo();
    const n = makeNode(x, y);
    state.model.nodes.push(n);
    return { node: n, created: true };
  }
  function ensureActiveGroup() {
    if (!state.activeGroup || !state.model.groups.includes(state.activeGroup)) state.activeGroup = state.model.groups[0];
    if (!state.activeGroup) {
      const g = makeGroup('Default: A 2000 mm²', state.model.materials[0] || makeMaterial('steel'), { type: 'custom' }, GROUP_COLORS[0], 2000 * MM2, 2e6 * MM4);
      if (!state.model.materials.length) state.model.materials.push(g.material);
      state.model.groups.push(g);
      state.activeGroup = g;
      renderLeftLists();
    }
    return state.activeGroup;
  }
  function addMemberBetween(a, b) {
    if (a === b) return null;
    if (findMember(a, b)) { toast(`Nodes ${nodeNo(a)} and ${nodeNo(b)} are already connected`, 'warn'); return null; }
    const e = makeMember(a, b, ensureActiveGroup());
    state.model.members.push(e);
    return e;
  }
  function deleteSelection() {
    const ns = state.sel.nodes, ms = state.sel.members;
    if (!ns.size && !ms.size) return;
    pushUndo();
    const nCount = ns.size;
    const before = state.model.members.length;
    state.model.members = state.model.members.filter((e) => !ms.has(e) && !ns.has(e.n1) && !ns.has(e.n2));
    state.model.nodes = state.model.nodes.filter((n) => !ns.has(n));
    if (state.memberStart && state.memberStart.node && ns.has(state.memberStart.node)) state.memberStart = null;
    const mCount = before - state.model.members.length;
    clearSelection(false);
    toast(`Deleted ${plural(nCount, 'node')} and ${plural(mCount, 'member')}`);
    modelChanged();
  }
  function nudge(dx, dy) {
    const nodes = new Set(state.sel.nodes);
    state.sel.members.forEach((e) => { nodes.add(e.n1); nodes.add(e.n2); });
    if (!nodes.size) return;
    pushUndo();
    for (const n of nodes) {
      n.x = onGrid(n.x) ? snapCoord(n.x + dx) : n.x + dx;
      n.y = onGrid(n.y) ? snapCoord(n.y + dy) : n.y + dy;
    }
    modelChanged({ keepInspector: true });
    syncInspectorInputs();
  }

  /* =====================================================================
   * 9. Pointer, wheel and keyboard interaction
   * ===================================================================== */
  function localPos(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function setTool(t) {
    state.tool = t;
    if (t !== 'member') state.memberStart = null;
    $$('#tools .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    canvas.className = `tool-${t}`;
    renderToolOptions();
    refreshHint();
    requestRender();
  }
  const HINTS = {
    select: 'Click to select · Shift+click adds · drag nodes to move · drag empty space for box select · Del deletes',
    node: 'Click to place a node (snaps to grid/nodes) · or type exact X, Y above',
    member: 'Click start node, then end node (empty space creates a node) · Esc / right-click ends the chain',
    support: 'Choose a support type above, then click nodes · clicking a node with the same support removes it',
    load: 'Set Fx, Fy above, then click nodes to apply · positive = +x right / +y up',
    pan: 'Drag to pan · wheel to zoom at cursor',
  };
  function refreshHint() { $('#sbHint').textContent = HINTS[state.tool] || ''; }

  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = localPos(e);
    state.pointer.sx = sx; state.pointer.sy = sy;
    hideTooltip();
    if (e.button === 2 && state.tool === 'member' && state.memberStart) { state.memberStart = null; requestRender(); return; }
    if (e.button === 1 || e.button === 2 || state.tool === 'pan' || state.spaceDown) {
      state.drag = { type: 'pan', sx, sy, cx: state.view.cx, cy: state.view.cy, moved: false };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('panning');
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    switch (state.tool) {
      case 'select': downSelect(e, sx, sy); break;
      case 'node': downNode(sx, sy); break;
      case 'member': downMember(sx, sy); break;
      case 'support': downSupport(sx, sy); break;
      case 'load': downLoad(sx, sy); break;
      default: break;
    }
  });
  function downSelect(e, sx, sy) {
    const hit = pick(sx, sy);
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit) {
      if (add) { toggleSel(hit.kind, hit.obj); return; }
      const set = hit.kind === 'node' ? state.sel.nodes : state.sel.members;
      if (!set.has(hit.obj)) selectOnly(hit.kind, hit.obj);
      const nodes = new Set(state.sel.nodes);
      state.sel.members.forEach((m) => { nodes.add(m.n1); nodes.add(m.n2); });
      const [wx, wy] = s2w(sx, sy);
      const anchor = hit.kind === 'node' ? hit.obj : null;
      state.drag = {
        type: 'move', nodes: [...nodes], start: new Map([...nodes].map((n) => [n, [n.x, n.y]])),
        w0: [wx, wy], anchor, a0: anchor ? [anchor.x, anchor.y] : null, sx, sy, moved: false, snap: snapshot(),
      };
    } else {
      state.drag = { type: 'box', x0: sx, y0: sy, add, moved: false };
    }
  }
  function downNode(sx, sy) {
    const pt = resolvePoint(sx, sy);
    if (pt.node) { selectOnly('node', pt.node); return; }
    const { node } = addNodeAt(pt.x, pt.y);
    selectOnly('node', node);
    modelChanged();
  }
  function downMember(sx, sy) {
    const pt = resolvePoint(sx, sy);
    if (!state.memberStart) { state.memberStart = pt.node ? { node: pt.node } : { node: null, x: pt.x, y: pt.y }; requestRender(); return; }
    const st = state.memberStart;
    if (pt.node && pt.node === st.node) return;
    if (!st.node && !pt.node && Math.abs(st.x - pt.x) < 1e-12 && Math.abs(st.y - pt.y) < 1e-12) return;
    if (st.node && pt.node && findMember(st.node, pt.node)) { toast(`Nodes ${nodeNo(st.node)} and ${nodeNo(pt.node)} are already connected`, 'warn'); state.memberStart = { node: pt.node }; requestRender(); return; }
    pushUndo();
    const a = st.node || addNodeAt(st.x, st.y, false).node;
    const b = pt.node || addNodeAt(pt.x, pt.y, false).node;
    const e = addMemberBetween(a, b);
    state.memberStart = state.s.chain ? { node: b } : null;
    if (e) selectOnly('member', e);
    modelChanged();
  }
  function downSupport(sx, sy) {
    const n = pickNode(sx, sy, 10);
    if (!n) return;
    pushUndo();
    const t = state.supTool;
    const same = n.support.type === t.type && (t.type !== 'inclined' || n.support.angle === t.angle);
    if (same && t.type !== 'custom') setSupport(n, 'none');
    else setSupport(n, t.type, t.type === 'inclined' ? t.angle : undefined);
    selectOnly('node', n);
    modelChanged();
  }
  function downLoad(sx, sy) {
    const n = pickNode(sx, sy, 10);
    if (!n) return;
    pushUndo();
    const t = state.loadTool;
    if (t.mode === 'clear') { n.load.fx = 0; n.load.fy = 0; }
    else if (t.mode === 'add') { n.load.fx += t.fx; n.load.fy += t.fy; }
    else { n.load.fx = t.fx; n.load.fy = t.fy; }
    selectOnly('node', n);
    modelChanged();
  }

  window.addEventListener('pointermove', (e) => {
    const [sx, sy] = localPos(e);
    const inside = sx >= 0 && sy >= 0 && sx <= state.W && sy <= state.H && e.target === canvas;
    state.pointer.sx = sx; state.pointer.sy = sy; state.pointer.inside = inside || !!state.drag;
    const d = state.drag;
    if (d) {
      if (d.type === 'pan') {
        state.view.cx = d.cx - (sx - d.sx) / state.view.zoom;
        state.view.cy = d.cy + (sy - d.sy) / state.view.zoom;
        d.moved = true;
        requestRender();
      } else if (d.type === 'move') {
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
        if (!d.moved) { d.moved = true; pushUndo(d.snap); canvas.classList.add('dragging'); }
        const [wx, wy] = s2w(sx, sy);
        let ddx = wx - d.w0[0], ddy = wy - d.w0[1];
        if (d.anchor && state.s.snap) { ddx = snapCoord(d.a0[0] + ddx) - d.a0[0]; ddy = snapCoord(d.a0[1] + ddy) - d.a0[1]; }
        else if (state.s.snap) { ddx = snapCoord(ddx); ddy = snapCoord(ddy); }
        for (const n of d.nodes) {
          const [x0, y0] = d.start.get(n);
          n.x = state.s.snap && onGrid(x0) ? snapCoord(x0 + ddx) : x0 + ddx;
          n.y = state.s.snap && onGrid(y0) ? snapCoord(y0 + ddy) : y0 + ddy;
        }
        state.stale = true;
        requestSolve();
        requestRender();
        syncInspectorInputs();
      } else if (d.type === 'box') {
        d.moved = d.moved || Math.hypot(sx - d.x0, sy - d.y0) > 3;
        requestRender();
      }
      updateCoords(sx, sy);
      return;
    }
    if (!inside) return;
    updateCoords(sx, sy);
    const hit = state.tool === 'pan' ? null : pick(sx, sy);
    const prev = state.hover && state.hover.obj;
    state.hover = hit;
    canvas.classList.toggle('hovering', !!hit && state.tool !== 'node');
    if ((hit && hit.obj) !== prev || state.tool === 'node' || state.tool === 'member') requestRender();
    if (hit) showTooltip(hit, sx, sy); else hideTooltip();
  });
  window.addEventListener('pointerup', (e) => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    canvas.classList.remove('panning', 'dragging');
    if (d.type === 'pan') { scheduleSave(); return; }
    if (d.type === 'move') {
      if (d.moved) { modelChanged({ keepInspector: true }); syncInspectorInputs(); renderInspectorResults(); }
      return;
    }
    if (d.type === 'box') {
      const [sx, sy] = localPos(e);
      if (!d.moved) { if (!d.add) clearSelection(); return; }
      const x0 = Math.min(d.x0, sx), x1 = Math.max(d.x0, sx), y0 = Math.min(d.y0, sy), y1 = Math.max(d.y0, sy);
      if (!d.add) { state.sel.nodes.clear(); state.sel.members.clear(); }
      const inBox = (n) => { const [px, py] = w2s(n.x, n.y); return px >= x0 && px <= x1 && py >= y0 && py <= y1; };
      state.model.nodes.forEach((n) => { if (inBox(n)) state.sel.nodes.add(n); });
      state.model.members.forEach((m) => { if (inBox(m.n1) && inBox(m.n2)) state.sel.members.add(m); });
      renderInspector(); renderTablesIfVisible(); requestRender();
    }
  });
  canvas.addEventListener('pointerleave', () => { if (!state.drag) { state.pointer.inside = false; state.hover = null; hideTooltip(); requestRender(); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = localPos(e);
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(Math.exp(-e.deltaY * unit * 0.0016), sx, sy);
  }, { passive: false });

  function updateCoords(sx, sy) {
    let [x, y] = s2w(sx, sy);
    if (state.s.snap && (state.tool === 'node' || state.tool === 'member')) { x = snapCoord(x); y = snapCoord(y); }
    $('#sbCoords').textContent = `x ${fmt(x, 5)} m, y ${fmt(y, 5)} m`;
  }

  const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'range';
  window.addEventListener('keydown', (e) => {
    if (!$('#helpModal').hidden) { if (e.key === 'Escape') toggleHelp(false); return; }
    if (isTyping(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); exportModel(); }
      else if (k === 'o') { e.preventDefault(); $('#fileInput').click(); }
      else if (k === 'a') { e.preventDefault(); selectAll(); }
      return;
    }
    if (e.altKey) return;
    const step = state.s.grid * (e.shiftKey ? 10 : 1);
    switch (k) {
      case 'v': setTool('select'); break;
      case 'n': setTool('node'); break;
      case 'm': setTool('member'); break;
      case 's': setTool('support'); break;
      case 'l': setTool('load'); break;
      case 'h': setTool('pan'); break;
      case 'f': fitView(); break;
      case 'g': state.s.snap = !state.s.snap; syncSettingsUI(); toast(`Grid snap ${state.s.snap ? 'on' : 'off'}`); break;
      case 'd': state.s.showDeformed = !state.s.showDeformed; syncSettingsUI(); requestRender(); break;
      case 'enter': e.preventDefault(); solve(true); break;
      case 'delete': case 'backspace': e.preventDefault(); deleteSelection(); break;
      case 'escape':
        if (state.memberStart) state.memberStart = null;
        else clearSelection();
        requestRender();
        break;
      case '?': toggleHelp(true); break;
      case 'arrowleft': e.preventDefault(); nudge(-step, 0); break;
      case 'arrowright': e.preventDefault(); nudge(step, 0); break;
      case 'arrowup': e.preventDefault(); nudge(0, step); break;
      case 'arrowdown': e.preventDefault(); nudge(0, -step); break;
      case ' ': state.spaceDown = true; e.preventDefault(); break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') state.spaceDown = false; });

  /* ---------- tool option bar ---------- */
  function renderToolOptions() {
    const box = $('#toolOptions');
    const fu = state.s.forceUnit;
    let h = '';
    switch (state.tool) {
      case 'node':
        h = `<label>X <input class="num w6" id="toX" placeholder="0" title="Exact x (m). Expressions allowed"></label>
             <label>Y <input class="num w6" id="toY" placeholder="0" title="Exact y (m). Expressions allowed"></label><span class="dim">m</span>
             <button class="btn sm" id="toAddNode">Add node</button><span class="sep"></span><span class="hint">${HINTS.node}</span>`;
        break;
      case 'member':
        h = `<label>Section <select class="select" id="toGroup">${state.model.groups.map((g, i) => `<option value="${i}" ${g === state.activeGroup ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
             <span class="sep"></span>
             <label>From N<input class="num w4" id="toFrom"></label><label>to N<input class="num w4" id="toTo"></label>
             <button class="btn sm" id="toConnect">Connect</button>
             <label class="chk" title="Continue drawing from the end node"><input type="checkbox" id="toChain" ${state.s.chain ? 'checked' : ''}> Chain</label>`;
        break;
      case 'support':
        h = `<label>Type <select class="select" id="toSupType">${SUPPORT_TYPES.filter(([k]) => k !== 'none').map(([k, l]) => `<option value="${k}" ${k === state.supTool.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
             <label id="toAngleWrap" ${state.supTool.type === 'inclined' ? '' : 'hidden'}>Surface α <input class="num w5" id="toAngle" value="${inVal(state.supTool.angle)}"> °</label>
             <span class="sep"></span><span class="hint">${HINTS.support}</span>`;
        break;
      case 'load':
        h = `<label>Fx <input class="num w6" id="toFx" value="${inVal(state.loadTool.fx / fU())}"></label>
             <label>Fy <input class="num w6" id="toFy" value="${inVal(state.loadTool.fy / fU())}"></label><span class="dim">${fu}</span>
             <label>Mode <select class="select" id="toLoadMode"><option value="set">Set</option><option value="add">Add</option><option value="clear">Clear</option></select></label>
             <span class="sep"></span><span class="hint">Click nodes to apply</span>`;
        break;
      case 'pan': h = `<span class="hint">${HINTS.pan}</span>`; break;
      default: h = `<span class="hint">${HINTS.select}</span>`;
    }
    box.innerHTML = h;
    const on = (id, ev, fn) => { const el = $('#' + id); if (el) el.addEventListener(ev, fn); };
    const addNode = () => {
      const x = evalNum($('#toX').value || '0'), y = evalNum($('#toY').value || '0');
      if (!Number.isFinite(x) || !Number.isFinite(y)) { toast('Enter valid X and Y values', 'bad'); return; }
      const r = addNodeAt(x, y);
      if (!r.created) toast(`Node ${nodeNo(r.node)} already exists at that position`, 'warn');
      selectOnly('node', r.node);
      modelChanged();
    };
    on('toAddNode', 'click', addNode);
    ['toX', 'toY'].forEach((id) => on(id, 'keydown', (e) => { if (e.key === 'Enter') addNode(); }));
    on('toGroup', 'change', (e) => { state.activeGroup = state.model.groups[+e.target.value]; renderLeftLists(); });
    const connect = () => {
      const a = state.model.nodes[Math.round(evalNum($('#toFrom').value)) - 1], b = state.model.nodes[Math.round(evalNum($('#toTo').value)) - 1];
      if (!a || !b || a === b) { toast('Enter two different existing node numbers', 'bad'); return; }
      if (findMember(a, b)) { toast('Those nodes are already connected', 'warn'); return; }
      pushUndo();
      const e = addMemberBetween(a, b);
      selectOnly('member', e);
      modelChanged();
    };
    on('toConnect', 'click', connect);
    ['toFrom', 'toTo'].forEach((id) => on(id, 'keydown', (e) => { if (e.key === 'Enter') connect(); }));
    on('toChain', 'change', (e) => { state.s.chain = e.target.checked; scheduleSave(); });
    on('toSupType', 'change', (e) => { state.supTool.type = e.target.value; $('#toAngleWrap').hidden = e.target.value !== 'inclined'; });
    on('toAngle', 'change', (e) => { const v = evalNum(e.target.value); if (Number.isFinite(v)) state.supTool.angle = v; else e.target.value = inVal(state.supTool.angle); });
    on('toFx', 'change', (e) => { const v = evalNum(e.target.value); if (Number.isFinite(v)) state.loadTool.fx = v * fU(); else e.target.value = inVal(state.loadTool.fx / fU()); });
    on('toFy', 'change', (e) => { const v = evalNum(e.target.value); if (Number.isFinite(v)) state.loadTool.fy = v * fU(); else e.target.value = inVal(state.loadTool.fy / fU()); });
    const lm = $('#toLoadMode');
    if (lm) { lm.value = state.loadTool.mode; lm.addEventListener('change', (e) => { state.loadTool.mode = e.target.value; }); }
  }

  /* ---------- hover tooltips ---------- */
  const tooltip = $('#tooltip');
  function hideTooltip() { tooltip.hidden = true; }
  function showTooltip(hit, sx, sy) {
    const r = R();
    const fu = state.s.forceUnit, du = state.s.dispUnit;
    const row = (k, v, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${k}</td><td>${v}</td></tr>`;
    let h = '';
    if (hit.kind === 'node') {
      const n = hit.obj, nr = r && r.ok ? nodeRes(r, n) : null;
      h = `<div class="tt-h">Node ${nodeNo(n)}<small>(${fmt(n.x, 6)}, ${fmt(n.y, 6)}) m</small></div><table>`;
      h += row('Support', esc(supportText(n.support)));
      if (n.load.fx || n.load.fy) h += row('Load (×λ)', `${fF(n.load.fx * state.s.loadFactor)}, ${fF(n.load.fy * state.s.loadFactor)} ${fu}`);
      if (nr) {
        const ref = r.summary.maxDisp.value;
        h += row('u<sub>x</sub>', `${fD(nr.ux, ref)} ${du}`, 'sep') + row('u<sub>y</sub>', `${fD(nr.uy, ref)} ${du}`) + row('|u|', `${fD(nr.u, ref)} ${du}`);
        if (nr.restrained[0] || nr.restrained[1]) {
          const ref2 = r.summary.Fref;
          h += row('R<sub>x</sub>', `${fF(nr.rx, ref2)} ${fu}`, 'sep') + row('R<sub>y</sub>', `${fF(nr.ry, ref2)} ${fu}`);
          if (nr.rotated) h += row(n.support.type === 'inclined' ? 'R<sub>n</sub> (normal)' : 'R<sub>x′</sub>, R<sub>y′</sub>', n.support.type === 'inclined' ? `${fF(nr.rLocal[1], ref2)} ${fu}` : `${fF(nr.rLocal[0], ref2)}, ${fF(nr.rLocal[1], ref2)} ${fu}`);
        }
      }
      h += '</table>';
    } else {
      const e = hit.obj, mr = r && r.ok ? memberRes(r, e) : null;
      const L = Math.hypot(e.n2.x - e.n1.x, e.n2.y - e.n1.y), th = Math.atan2(e.n2.y - e.n1.y, e.n2.x - e.n1.x) / D2R;
      h = `<div class="tt-h">Member ${memberNo(e)}<small>N${nodeNo(e.n1)} → N${nodeNo(e.n2)}</small></div><table>`;
      h += row('Section', esc(e.group.name)) + row('Material', esc(e.group.material.name));
      h += row('L, θ', `${fmt(L, 6)} m, ${fmt(th, 5)}°`);
      if (mr) {
        const ref = r.summary.Fref, kind = mr.state === 'zero' ? 'zero-force' : mr.state;
        h += row('Axial force F', `${mr.state === 'zero' ? '0' : fF(mr.force, ref)} ${fu} <span class="dim">${kind}</span>`, 'sep');
        h += row('Stress σ', `${mr.state === 'zero' ? '0' : fS(mr.stress, ref / mr.A)} MPa`);
        h += row('Strain ε', mr.state === 'zero' ? '0' : fmt(mr.strain));
        h += row('ΔL', `${mr.state === 'zero' ? '0' : fD(mr.elong)} ${du}`);
        h += row('P<sub>cr</sub> (Euler)', `${fF(mr.Pcr)} ${fu}`, 'sep');
        h += row('Slenderness L/r', fmt(mr.slenderness, 4));
        h += row('SF yield / buckling', `${fmt(mr.sfYield, 3)} / ${fmt(mr.sfBuckling, 3)}`);
        h += row('Safety factor', `<b>${fmt(mr.sf, 3)}</b>${mr.governs !== 'none' ? ` <span class="dim">${mr.governs}</span>` : ''}`);
        h += row('Status', statusBadge(mr));
      }
      h += '</table>';
    }
    tooltip.innerHTML = h;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th2 = tooltip.offsetHeight;
    let x = sx + 16, y = sy + 16;
    if (x + tw > state.W - 6) x = sx - tw - 14;
    if (y + th2 > state.H - 6) y = Math.max(6, sy - th2 - 12);
    tooltip.style.left = `${Math.max(6, x)}px`;
    tooltip.style.top = `${y}px`;
  }
  function statusBadge(mr) {
    if (mr.status === 'yielded') return '<span class="badge yielded">Yielded</span>';
    if (mr.status === 'buckled') return '<span class="badge buckled">Buckled</span>';
    if (mr.state === 'zero') return '<span class="badge zero">Safe · zero-force</span>';
    if (mr.lowSF) return '<span class="badge low">Safe · SF &lt; target</span>';
    return '<span class="badge safe">Safe</span>';
  }

  /* =====================================================================
   * 10. Left panel: materials, section groups, settings
   * ===================================================================== */
  function renderLeftLists() { renderMaterials(); renderGroups(); renderGroupEditor(); if (state.tool === 'member') renderToolOptions(); }

  function renderMaterials() {
    const box = $('#materialsList');
    const used = new Map();
    state.model.groups.forEach((g) => used.set(g.material, (used.get(g.material) || 0) + 1));
    box.innerHTML = state.model.materials.map((m, i) => `
      <div class="mat-card" data-mi="${i}">
        <div class="mat-top">
          <input type="color" data-mf="color" value="${esc(m.color)}" title="Display colour">
          <input class="txt" data-mf="name" value="${esc(m.name)}" title="Material name">
          <button class="icon-btn" data-mf="del" title="${used.get(m) ? 'Used by section groups' : 'Delete material'}">&#10005;</button>
        </div>
        <div class="mat-props">
          <label>E <input class="num" data-mf="E" value="${inVal(m.E / GPA)}" title="Young's modulus, GPa"><span class="u">GPa</span></label>
          <label>σ<sub>y</sub> <input class="num" data-mf="fy" value="${inVal(m.fy / MPA)}" title="Yield / limit stress, MPa"><span class="u">MPa</span></label>
        </div>
        ${m.preset === 'fir' ? `<div class="mat-note">${esc(FIR_NOTE)}</div>` : ''}
      </div>`).join('');
    box.querySelectorAll('.mat-card').forEach((card) => {
      const m = state.model.materials[+card.dataset.mi];
      card.querySelectorAll('[data-mf]').forEach((el) => {
        const f = el.dataset.mf;
        if (f === 'del') {
          el.addEventListener('click', () => {
            if (used.get(m)) { toast(`“${m.name}” is used by ${plural(used.get(m), 'section group')}`, 'warn'); return; }
            if (state.model.materials.length <= 1) { toast('At least one material is required', 'warn'); return; }
            pushUndo();
            state.model.materials.splice(state.model.materials.indexOf(m), 1);
            modelChanged({ materials: true });
          });
          return;
        }
        el.addEventListener('change', () => {
          if (f === 'name') { pushUndo(); m.name = el.value.trim() || 'Material'; modelChanged({ materials: true, groups: true }); return; }
          if (f === 'color') { m.color = el.value; scheduleSave(); return; }
          const v = evalNum(el.value);
          if (!(v > 0)) { el.classList.add('invalid'); toast(`${f === 'E' ? 'E' : 'σy'} must be a positive number`, 'bad'); return; }
          el.classList.remove('invalid');
          pushUndo();
          if (f === 'E') m.E = v * GPA; else m.fy = v * MPA;
          el.value = inVal(v);
          modelChanged({ groups: true });
        });
      });
    });
  }

  function renderGroups() {
    const box = $('#groupsList');
    const count = new Map();
    state.model.members.forEach((e) => count.set(e.group, (count.get(e.group) || 0) + 1));
    if (!state.model.groups.includes(state.activeGroup)) state.activeGroup = state.model.groups[0] || null;
    box.innerHTML = state.model.groups.map((g, i) => `
      <div class="grp-row ${g === state.editGroup ? 'editing' : ''}" data-gi="${i}" title="Click to edit this section group">
        <input type="radio" name="activeGroup" ${g === state.activeGroup ? 'checked' : ''} title="Use for new members">
        <span class="swatch" style="background:${esc(g.color)}"></span>
        <span class="grp-name">${esc(g.name)}</span>
        <span class="grp-count" title="Members using this group">${count.get(g) || 0}</span>
        <span class="grp-meta">${esc(g.material.name)} · A ${fmt(g.A / MM2, 4)} mm² · I ${fmt(g.I / MM4, 3)} mm⁴</span>
      </div>`).join('');
    box.querySelectorAll('.grp-row').forEach((row) => {
      const g = state.model.groups[+row.dataset.gi];
      row.querySelector('input[type=radio]').addEventListener('click', (e) => { e.stopPropagation(); state.activeGroup = g; if (state.tool === 'member') renderToolOptions(); });
      row.addEventListener('click', () => { state.editGroup = state.editGroup === g ? null : g; renderGroups(); renderGroupEditor(); });
    });
  }

  function renderGroupEditor() {
    const box = $('#groupEditor');
    const g = state.editGroup;
    if (!g || !state.model.groups.includes(g)) { state.editGroup = null; box.innerHTML = ''; return; }
    const sh = SHAPES[g.shape.type] ? g.shape.type : 'custom';
    const dims = SHAPES[sh].dims.map(([k, label]) => `<label>${label}</label><div class="inline"><input class="num" data-gf="dim" data-k="${k}" value="${inVal((g.shape[k] || 0) / MM)}"><span class="u">mm</span></div>`).join('');
    const custom = sh === 'custom';
    const r = Math.sqrt(g.I / g.A);
    box.innerHTML = `
      <div class="grp-editor">
        <div class="form-grid">
          <label>Name</label><div class="inline"><input class="txt" data-gf="name" value="${esc(g.name)}"><input type="color" data-gf="color" value="${esc(g.color)}"></div>
          <label>Material</label><select class="select" data-gf="material">${state.model.materials.map((m, i) => `<option value="${i}" ${m === g.material ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
          <label>Shape</label><select class="select" data-gf="shape">${Object.entries(SHAPES).map(([k, s]) => `<option value="${k}" ${k === sh ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
          ${dims}
          <label>Area A</label><div class="inline"><input class="num" data-gf="A" value="${inVal(g.A / MM2)}" ${custom ? '' : 'disabled'}><span class="u">mm²</span></div>
          <label>I (weak axis)</label><div class="inline"><input class="num" data-gf="I" value="${inVal(g.I / MM4)}" ${custom ? '' : 'disabled'}><span class="u">mm⁴</span></div>
        </div>
        <div class="derived">r = √(I/A) = ${fmt(r / MM, 4)} mm · EA = ${fmt(g.material.E * g.A / 1e6, 4)} MN<br>
          σy·A = ${fmt(g.material.fy * g.A / fU(), 4)} ${state.s.forceUnit} · λc = π√(E/σy) = ${fmt(Math.PI * Math.sqrt(g.material.E / g.material.fy), 4)}</div>
        <div class="btn-row">
          <button class="btn sm" data-gf="assign" title="Assign this section to the selected members">Assign to selected</button>
          <button class="btn sm" data-gf="select" title="Select all members of this group">Select members</button>
          <button class="btn sm danger" data-gf="del">Delete</button>
        </div>
      </div>`;
    box.querySelectorAll('[data-gf]').forEach((el) => {
      const f = el.dataset.gf;
      if (el.tagName === 'BUTTON') {
        el.addEventListener('click', () => {
          if (f === 'assign') {
            if (!state.sel.members.size) { toast('Select members first (V, then click or box-select)', 'warn'); return; }
            pushUndo(); state.sel.members.forEach((e) => { e.group = g; });
            toast(`Assigned “${g.name}” to ${plural(state.sel.members.size, 'member')}`, 'ok');
            modelChanged({ groups: true });
          } else if (f === 'select') {
            state.sel.nodes.clear(); state.sel.members.clear();
            state.model.members.forEach((e) => { if (e.group === g) state.sel.members.add(e); });
            renderInspector(); renderTablesIfVisible(); requestRender();
          } else if (f === 'del') {
            const n = state.model.members.filter((e) => e.group === g).length;
            if (n) { toast(`“${g.name}” is used by ${plural(n, 'member')}; reassign them first`, 'warn'); return; }
            if (state.model.groups.length <= 1) { toast('At least one section group is required', 'warn'); return; }
            pushUndo();
            state.model.groups.splice(state.model.groups.indexOf(g), 1);
            state.editGroup = null;
            modelChanged({ groups: true });
          }
        });
        return;
      }
      el.addEventListener('change', () => {
        if (f === 'name') { pushUndo(); g.name = el.value.trim() || 'Section'; modelChanged({ groups: true }); return; }
        if (f === 'color') { g.color = el.value; renderGroups(); scheduleSave(); return; }
        if (f === 'material') { pushUndo(); g.material = state.model.materials[+el.value]; modelChanged({ groups: true }); return; }
        if (f === 'shape') {
          pushUndo();
          const type = el.value, shape = { type };
          if (type === 'rod') shape.d = Math.sqrt(4 * g.A / Math.PI);
          if (type === 'chs') { shape.D = 100 * MM; shape.t = 5 * MM; }
          if (type === 'rect') { shape.b = 50 * MM; shape.h = 100 * MM; }
          if (type === 'rhs') { shape.b = 100 * MM; shape.h = 100 * MM; shape.t = 5 * MM; }
          g.shape = shape;
          const sp = sectionProps(shape);
          if (sp) { g.A = sp.A; g.I = sp.I; }
          modelChanged({ groups: true });
          return;
        }
        const v = evalNum(el.value);
        if (!(v > 0)) { el.classList.add('invalid'); toast('Enter a positive number', 'bad'); return; }
        if (f === 'dim') {
          const trial = Object.assign({}, g.shape, { [el.dataset.k]: v * MM });
          const sp = sectionProps(trial);
          if (!sp) { el.classList.add('invalid'); toast('Invalid dimensions (wall too thick?)', 'bad'); return; }
          pushUndo(); g.shape = trial; g.A = sp.A; g.I = sp.I;
        } else {
          pushUndo();
          if (f === 'A') g.A = v * MM2; else g.I = v * MM4;
        }
        modelChanged({ groups: true });
      });
    });
  }

  function syncScaleUI() {
    const s = state.s.scale;
    $('#rngScale').value = String(clamp(Math.log10(Math.max(s, 1)), 0, 3));
    if (document.activeElement !== $('#numScale')) $('#numScale').value = inVal(s);
    $('#btnAutoScale').classList.toggle('on', state.s.autoScale);
  }
  function syncSettingsUI() {
    const s = state.s;
    $$('#segGrid button').forEach((b) => b.classList.toggle('on', +b.dataset.grid === s.grid));
    $$('#segColor button').forEach((b) => b.classList.toggle('on', b.dataset.color === s.colorBy));
    $('#chkSnap').checked = s.snap; $('#chkSnapNodes').checked = s.snapNodes; $('#chkGrid').checked = s.showGrid;
    $('#chkLive').checked = s.liveSolve;
    $$('[data-show]').forEach((el) => { el.checked = !!s[el.dataset.show]; });
    $('#selForceUnit').value = s.forceUnit; $('#selDispUnit').value = s.dispUnit; $('#selDigits').value = String(s.sig);
    $('#rngLoadFactor').value = String(clamp(s.loadFactor, 0, 3));
    if (document.activeElement !== $('#numLoadFactor')) $('#numLoadFactor').value = inVal(s.loadFactor);
    if (document.activeElement !== $('#numTargetSF')) $('#numTargetSF').value = inVal(s.targetSF);
    $$('#segMatrix button').forEach((b) => b.classList.toggle('on', b.dataset.mtx === s.mtxView));
    $$('#segMtxMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.mtxMode));
    $('#selMtxUnit').value = s.mtxUnit; $('#chkHideZeros').checked = s.mtxDimZeros;
    $('#sbSnap').textContent = `snap ${s.snap ? s.grid + ' m' : 'off'}`;
    syncScaleUI();
  }

  function bindLeftPanel() {
    $('#btnAddMaterial').addEventListener('click', () => {
      pushUndo();
      const m = makeMaterial($('#selAddMaterial').value);
      state.model.materials.push(m);
      modelChanged({ materials: true });
      toast(`Added material “${m.name}”`, 'ok');
    });
    $('#btnAddGroup').addEventListener('click', () => {
      pushUndo();
      const i = state.model.groups.length;
      const base = state.editGroup || state.activeGroup;
      const g = makeGroup(`Section ${i + 1}`, base ? base.material : state.model.materials[0], base ? Object.assign({}, base.shape) : { type: 'custom' }, GROUP_COLORS[i % GROUP_COLORS.length], base ? base.A : 2000 * MM2, base ? base.I : 2e6 * MM4);
      state.model.groups.push(g);
      state.editGroup = g;
      modelChanged({ groups: true });
    });
    $$('#segGrid button').forEach((b) => b.addEventListener('click', () => { state.s.grid = +b.dataset.grid; syncSettingsUI(); scheduleSave(); requestRender(); }));
    $('#chkSnap').addEventListener('change', (e) => { state.s.snap = e.target.checked; syncSettingsUI(); scheduleSave(); });
    $('#chkSnapNodes').addEventListener('change', (e) => { state.s.snapNodes = e.target.checked; scheduleSave(); });
    $('#chkGrid').addEventListener('change', (e) => { state.s.showGrid = e.target.checked; scheduleSave(); requestRender(); });
    const setLF = (v) => { state.s.loadFactor = v; syncSettingsUI(); scheduleSave(); requestSolve(); requestRender(); };
    $('#rngLoadFactor').addEventListener('input', (e) => setLF(+e.target.value));
    $('#numLoadFactor').addEventListener('change', (e) => { const v = evalNum(e.target.value); if (Number.isFinite(v) && v >= 0) setLF(v); else { toast('λ must be ≥ 0', 'bad'); syncSettingsUI(); } });
    $('#numTargetSF').addEventListener('change', (e) => {
      const v = evalNum(e.target.value);
      if (Number.isFinite(v) && v >= 1) { state.s.targetSF = v; scheduleSave(); requestSolve(); } else { toast('Target SF must be ≥ 1', 'bad'); }
      syncSettingsUI();
    });
    $('#rngScale').addEventListener('input', (e) => { state.s.scale = parseFloat(Math.pow(10, +e.target.value).toPrecision(3)); state.s.autoScale = false; syncScaleUI(); scheduleSave(); requestRender(); });
    $('#numScale').addEventListener('change', (e) => {
      const v = evalNum(e.target.value);
      if (Number.isFinite(v) && v > 0 && v <= 1e6) { state.s.scale = v; state.s.autoScale = false; } else toast('Scale must be between 0 and 10⁶', 'bad');
      syncScaleUI(); scheduleSave(); requestRender();
    });
    $('#btnAutoScale').addEventListener('click', () => { state.s.autoScale = !state.s.autoScale; if (state.s.autoScale) autoScale(); syncScaleUI(); scheduleSave(); requestRender(); });
    $$('#segColor button').forEach((b) => b.addEventListener('click', () => { state.s.colorBy = b.dataset.color; syncSettingsUI(); renderLegend(); scheduleSave(); requestRender(); }));
    $$('[data-show]').forEach((el) => el.addEventListener('change', () => {
      state.s[el.dataset.show] = el.checked; scheduleSave(); renderLegend(); requestRender();
    }));
    const unitsChanged = () => { renderAllPanels(); renderToolOptions(); requestRender(); scheduleSave(); };
    $('#selForceUnit').addEventListener('change', (e) => { state.s.forceUnit = e.target.value; unitsChanged(); });
    $('#selDispUnit').addEventListener('change', (e) => { state.s.dispUnit = e.target.value; unitsChanged(); });
    $('#selDigits').addEventListener('change', (e) => { state.s.sig = +e.target.value; unitsChanged(); });
  }

  /* =====================================================================
   * 11. Inspector (right panel)
   * ===================================================================== */
  const numIn = (f, v, extra) => `<input class="num" data-f="${f}" value="${inVal(v)}" ${extra || ''}>`;
  function renderInspector() {
    const box = $('#inspector');
    const ns = [...state.sel.nodes].filter((n) => state.model.nodes.includes(n));
    const ms = [...state.sel.members].filter((e) => state.model.members.includes(e));
    state.sel.nodes = new Set(ns); state.sel.members = new Set(ms);
    let h;
    if (ns.length === 1 && !ms.length) h = nodeForm(ns[0]);
    else if (ms.length === 1 && !ns.length) h = memberForm(ms[0]);
    else if (ns.length + ms.length > 1) h = multiForm(ns, ms);
    else h = summaryView();
    box.innerHTML = h;
    $('#inspectorSub').textContent = ns.length + ms.length ? `${plural(ns.length, 'node')}, ${plural(ms.length, 'member')} selected` : 'nothing selected';
    bindInspector(box, ns, ms);
    renderInspectorResults();
  }
  function nodeForm(n) {
    const s = n.support, fu = state.s.forceUnit, du = state.s.dispUnit;
    const F = Math.hypot(n.load.fx, n.load.fy), ang = F > 0 ? Math.atan2(n.load.fy, n.load.fx) / D2R : 0;
    let sup = `<label>Type</label><select class="select" data-f="stype">${SUPPORT_TYPES.map(([k, l]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (s.type === 'inclined') sup += `<label>Surface α</label><div class="inline">${numIn('sangle', s.angle, 'title="Angle of the rolling surface from +x, degrees CCW"')}<span class="u">°</span></div>`;
    if (s.type === 'custom') {
      sup += `<label>Frame α</label><div class="inline">${numIn('sangle', s.angle, 'title="Rotation of the x′, y′ support frame from global x, degrees CCW"')}<span class="u">°</span></div>
        <label class="chk"><input type="checkbox" data-f="sfixx" ${s.fixX ? 'checked' : ''}> Fix x′, δ</label><div class="inline">${numIn('sdx', (s.dx || 0) / dU(), s.fixX ? '' : 'disabled')}<span class="u">${du}</span></div>
        <label class="chk"><input type="checkbox" data-f="sfixy" ${s.fixY ? 'checked' : ''}> Fix y′, δ</label><div class="inline">${numIn('sdy', (s.dy || 0) / dU(), s.fixY ? '' : 'disabled')}<span class="u">${du}</span></div>`;
    }
    return `
      <div class="ins-title"><h4>Node N${nodeNo(n)}<small>${esc(supportText(s))}</small></h4><button class="btn sm danger" data-act="del">Delete</button></div>
      <div class="sub-h">Coordinates</div>
      <div class="form-grid">
        <label>X</label><div class="inline">${numIn('x', n.x, 'title="Expressions allowed, e.g. 2.5*sqrt(3)"')}<span class="u">m</span></div>
        <label>Y</label><div class="inline">${numIn('y', n.y, 'title="Expressions allowed, e.g. 2.5*sqrt(3)"')}<span class="u">m</span></div>
      </div>
      <div class="sub-h">Support / boundary condition</div>
      <div class="form-grid">${sup}</div>
      <div class="sub-h">Nodal load (before λ)</div>
      <div class="form-grid">
        <label>F<sub>x</sub></label><div class="inline">${numIn('fx', n.load.fx / fU())}<span class="u">${fu}</span></div>
        <label>F<sub>y</sub></label><div class="inline">${numIn('fy', n.load.fy / fU())}<span class="u">${fu}</span></div>
        <label>|F|</label><div class="inline">${numIn('fmag', F / fU())}<span class="u">${fu}</span></div>
        <label>Direction</label><div class="inline">${numIn('fang', ang, 'title="Degrees CCW from +x (−90 = downward)"')}<span class="u">°</span></div>
      </div>
      <div class="sub-h">Results</div><div id="insResults"></div>`;
  }
  function memberForm(e) {
    return `
      <div class="ins-title"><h4>Member M${memberNo(e)}<small>N${nodeNo(e.n1)} → N${nodeNo(e.n2)}</small></h4>
        <div class="btn-row" style="margin:0"><button class="btn sm" data-act="flip" title="Reverse the member direction (results are unchanged)">⇄</button><button class="btn sm danger" data-act="del">Delete</button></div></div>
      <div class="form-grid">
        <label>Start node</label><div class="inline"><input class="num" data-f="n1" value="${nodeNo(e.n1)}"></div>
        <label>End node</label><div class="inline"><input class="num" data-f="n2" value="${nodeNo(e.n2)}"></div>
        <label>Section</label><select class="select" data-f="grp">${state.model.groups.map((g, i) => `<option value="${i}" ${g === e.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      </div>
      <div id="insResults"></div>`;
  }
  function multiForm(ns, ms) {
    const fu = state.s.forceUnit;
    let h = `<div class="ins-title"><h4>Multiple selection<small>${plural(ns.length, 'node')}, ${plural(ms.length, 'member')}</small></h4><button class="btn sm danger" data-act="del">Delete all</button></div>`;
    if (ns.length) {
      h += `<div class="sub-h">Apply to ${plural(ns.length, 'node')}</div>
        <div class="form-grid">
          <label>Support</label><div class="inline"><select class="select" data-m="stype">${SUPPORT_TYPES.filter(([k]) => k !== 'custom').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <label>Angle α</label><div class="inline"><input class="num" data-m="sangle" value="30"><span class="u">°</span><button class="btn sm" data-act="mm-support">Apply</button></div>
          <label>F<sub>x</sub></label><div class="inline"><input class="num" data-m="fx" value="0"><span class="u">${fu}</span></div>
          <label>F<sub>y</sub></label><div class="inline"><input class="num" data-m="fy" value="${inVal(-10e3 / fU())}"><span class="u">${fu}</span><button class="btn sm" data-act="mm-load">Apply</button></div>
        </div>`;
    }
    if (ms.length) {
      h += `<div class="sub-h">Apply to ${plural(ms.length, 'member')}</div>
        <div class="form-grid"><label>Section</label><div class="inline"><select class="select" data-m="grp">${state.model.groups.map((g, i) => `<option value="${i}">${esc(g.name)}</option>`).join('')}</select><button class="btn sm" data-act="mm-group">Apply</button></div></div>`;
    }
    return h + '<div id="insResults"></div>';
  }
  function summaryView() {
    const M = state.model, r = R();
    const nSup = M.nodes.filter((n) => n.support.type !== 'none').length;
    const nLoad = M.nodes.filter((n) => n.load.fx || n.load.fy).length;
    let det = '';
    if (r && r.determinacy) {
      const d = r.determinacy;
      det = `<dt>Maxwell m + r − 2j</dt><dd>${d.m} + ${d.r} − 2·${d.j} = ${d.degree}</dd>`;
    }
    return `
      <div class="form-grid" style="grid-template-columns:auto 1fr;margin-bottom:8px"><label>Title</label><input class="txt" data-f="title" value="${esc(M.title)}"></div>
      <dl class="kv">
        <dt>Nodes / joints</dt><dd>${M.nodes.length}</dd>
        <dt>Members</dt><dd>${M.members.length}</dd>
        <dt>Global DOFs</dt><dd>${2 * M.nodes.length}</dd>
        <dt>Supported nodes</dt><dd>${nSup}</dd>
        <dt>Loaded nodes</dt><dd>${nLoad}</dd>
        ${det}
      </dl>
      <div class="tip"><ul>
        <li>Click a node or member to inspect and edit it exactly.</li>
        <li><kbd>N</kbd> nodes · <kbd>M</kbd> members · <kbd>S</kbd> supports · <kbd>L</kbd> loads · <kbd>?</kbd> help.</li>
        <li>Box-select several items to assign supports, loads or sections in one go.</li>
      </ul></div>`;
  }
  function bindInspector(box, ns, ms) {
    box.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('change', () => onInspectorField(el, ns, ms));
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.blur(); });
    });
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => onInspectorAction(b.dataset.act, ns, ms, box)));
  }
  function readNum(el, positive) {
    const v = evalNum(el.value);
    if (!Number.isFinite(v) || (positive && !(v > 0))) { el.classList.add('invalid'); toast(`“${el.value}” is not a valid ${positive ? 'positive ' : ''}number`, 'bad'); return null; }
    el.classList.remove('invalid');
    return v;
  }
  function onInspectorField(el, ns, ms) {
    const f = el.dataset.f, n = ns[0], e = ms[0];
    if (f === 'title') { pushUndo(); state.model.title = el.value.trim() || 'Untitled truss'; scheduleSave(); return; }
    if (f === 'stype') { pushUndo(); setSupport(n, el.value, n.support.angle || 30); modelChanged(); return; }
    if (f === 'sfixx' || f === 'sfixy') { pushUndo(); n.support[f === 'sfixx' ? 'fixX' : 'fixY'] = el.checked; modelChanged(); return; }
    if (f === 'grp') { pushUndo(); e.group = state.model.groups[+el.value]; modelChanged({ groups: true }); return; }
    const v = readNum(el);
    if (v === null) return;
    if (f === 'n1' || f === 'n2') {
      const nn = state.model.nodes[Math.round(v) - 1];
      const other = f === 'n1' ? e.n2 : e.n1;
      if (!nn || nn === other) { el.classList.add('invalid'); toast('Enter an existing node number different from the other end', 'bad'); return; }
      const dup = findMember(nn, other);
      if (dup && dup !== e) { el.classList.add('invalid'); toast('Those nodes are already connected', 'warn'); return; }
      pushUndo(); e[f] = nn; modelChanged(); return;
    }
    pushUndo();
    switch (f) {
      case 'x': n.x = v; break;
      case 'y': n.y = v; break;
      case 'sangle': n.support.angle = v; break;
      case 'sdx': n.support.dx = v * dU(); break;
      case 'sdy': n.support.dy = v * dU(); break;
      case 'fx': n.load.fx = v * fU(); break;
      case 'fy': n.load.fy = v * fU(); break;
      case 'fmag': case 'fang': {
        const F = Math.hypot(n.load.fx, n.load.fy), a0 = F > 0 ? Math.atan2(n.load.fy, n.load.fx) / D2R : -90;
        const mag = f === 'fmag' ? v * fU() : F, ang = f === 'fang' ? v : a0;
        const [c, s] = cosSinDeg(ang);
        n.load.fx = mag * c; n.load.fy = mag * s;
        break;
      }
      default: return;
    }
    modelChanged({ keepInspector: true });
    syncInspectorInputs();
  }
  function onInspectorAction(act, ns, ms, box) {
    if (act === 'del') { deleteSelection(); return; }
    if (act === 'flip') { pushUndo(); const e = ms[0]; [e.n1, e.n2] = [e.n2, e.n1]; modelChanged(); return; }
    const q = (k) => box.querySelector(`[data-m="${k}"]`);
    if (act === 'mm-support') {
      const ang = readNum(q('sangle')); if (ang === null) return;
      pushUndo(); ns.forEach((n) => setSupport(n, q('stype').value, ang));
      toast(`Support applied to ${plural(ns.length, 'node')}`, 'ok'); modelChanged();
    } else if (act === 'mm-load') {
      const fx = readNum(q('fx')), fy = readNum(q('fy')); if (fx === null || fy === null) return;
      pushUndo(); ns.forEach((n) => { n.load.fx = fx * fU(); n.load.fy = fy * fU(); });
      toast(`Load applied to ${plural(ns.length, 'node')}`, 'ok'); modelChanged();
    } else if (act === 'mm-group') {
      pushUndo(); const g = state.model.groups[+q('grp').value]; ms.forEach((e) => { e.group = g; });
      toast(`Section applied to ${plural(ms.length, 'member')}`, 'ok'); modelChanged({ groups: true });
    }
  }
  /** Refresh input values after canvas edits without rebuilding the form (keeps focus). */
  function syncInspectorInputs() {
    const box = $('#inspector');
    const n = state.sel.nodes.size === 1 && !state.sel.members.size ? [...state.sel.nodes][0] : null;
    if (!n) return;
    const F = Math.hypot(n.load.fx, n.load.fy);
    const vals = { x: n.x, y: n.y, fx: n.load.fx / fU(), fy: n.load.fy / fU(), fmag: F / fU(), fang: F > 0 ? Math.atan2(n.load.fy, n.load.fx) / D2R : 0 };
    for (const [k, v] of Object.entries(vals)) { const el = box.querySelector(`[data-f="${k}"]`); if (el && el !== document.activeElement) { el.value = inVal(v); el.classList.remove('invalid'); } }
  }
  function renderInspectorResults() {
    const box = $('#insResults');
    if (!box) return;
    const r = R();
    const ns = [...state.sel.nodes], ms = [...state.sel.members];
    const fu = state.s.forceUnit, du = state.s.dispUnit;
    if (!r || !r.ok) {
      box.innerHTML = `<p class="note">${!r ? 'No results yet.' : r.mechanism ? 'Not available: the structure is unstable.' : 'Not available: the model cannot be analysed (see the health report).'}</p>`;
      if (ms.length === 1 && !ns.length) box.innerHTML = memberGeometry(ms[0]) + box.innerHTML;
      return;
    }
    if (ns.length === 1 && !ms.length) {
      const n = ns[0], nr = nodeRes(r, n);
      if (!nr) { box.innerHTML = '<p class="note">Node not yet analysed.</p>'; return; }
      const ref = r.summary.maxDisp.value, fref = r.summary.Fref;
      let h = `<dl class="kv">
        <dt>u<sub>x</sub></dt><dd>${fD(nr.ux, ref)} ${du}</dd>
        <dt>u<sub>y</sub></dt><dd>${fD(nr.uy, ref)} ${du}</dd>
        <dt>|u|</dt><dd>${fD(nr.u, ref)} ${du}</dd>`;
      if (nr.rotated) h += `<dt>u<sub>x′</sub>, u<sub>y′</sub></dt><dd>${fD(nr.uLocal[0], ref)}, ${fD(nr.uLocal[1], ref)} ${du}</dd>`;
      if (!nr.active) h += '<dt>Note</dt><dd class="warn">isolated: excluded</dd>';
      if (nr.restrained[0] || nr.restrained[1]) {
        h += `<dt>R<sub>x</sub></dt><dd>${fF(nr.rx, fref)} ${fu}</dd><dt>R<sub>y</sub></dt><dd>${fF(nr.ry, fref)} ${fu}</dd>
              <dt>|R|</dt><dd>${fF(Math.hypot(nr.rx, nr.ry), fref)} ${fu}</dd>`;
        if (nr.rotated) h += `<dt>R<sub>x′</sub>, R<sub>y′</sub></dt><dd>${fF(nr.rLocal[0], fref)}, ${fF(nr.rLocal[1], fref)} ${fu}</dd>`;
      }
      box.innerHTML = h + '</dl>';
      return;
    }
    if (ms.length === 1 && !ns.length) {
      const e = ms[0], mr = memberRes(r, e);
      if (!mr) { box.innerHTML = memberGeometry(e) + '<p class="note">Member not yet analysed.</p>'; return; }
      const ref = r.summary.Fref, z = mr.state === 'zero';
      const labels = mr.dofs.map((d) => r.dofLabels[d]);
      const ku = STIFF_UNITS[state.s.mtxUnit] || 1e3;
      let ke = `<table class="ke-table"><tr><th></th>${labels.map((l) => `<th>${l}</th>`).join('')}</tr>`;
      for (let a = 0; a < 4; a++) ke += `<tr><th>${labels[a]}</th>${[0, 1, 2, 3].map((b) => `<td class="${a === b ? 'diag' : ''}">${fmt(chop(mr.ke[a * 4 + b], mr.k) / ku, 4)}</td>`).join('')}</tr>`;
      ke += '</table>';
      box.innerHTML = memberGeometry(e) + `
        <div class="sub-h">Results</div>
        <dl class="kv">
          <dt>Axial force F</dt><dd class="${z ? '' : mr.force > 0 ? '' : ''}">${z ? '0' : fF(mr.force, ref)} ${fu} <small>${z ? 'zero-force' : mr.state}</small></dd>
          <dt>Stress σ = F/A</dt><dd>${z ? '0' : fS(mr.stress)} MPa</dd>
          <dt>Strain ε = ΔL/L</dt><dd>${z ? '0' : fmt(mr.strain)}</dd>
          <dt>Elongation ΔL</dt><dd>${z ? '0' : fD(mr.elong)} ${du}</dd>
          <dt>Euler P<sub>cr</sub> = π²EI/L²</dt><dd>${fF(mr.Pcr)} ${fu}</dd>
          <dt>σ<sub>cr</sub> / σ<sub>y</sub></dt><dd>${fmt(mr.sigmaCr / MPA)} / ${fmt(mr.fy / MPA)} MPa</dd>
          <dt>Slenderness L/r</dt><dd>${fmt(mr.slenderness, 4)}${mr.eulerValid ? '' : ' <small>(yield governs)</small>'}</dd>
          <dt>SF yield</dt><dd>${fmt(mr.sfYield, 4)}</dd>
          <dt>SF buckling</dt><dd>${fmt(mr.sfBuckling, 4)}</dd>
          <dt>Governing SF</dt><dd class="${mr.status !== 'safe' ? 'bad' : mr.lowSF ? 'warn' : 'ok'}">${fmt(mr.sf, 4)} <small>${mr.governs}</small></dd>
          <dt>Status</dt><dd>${statusBadge(mr)}</dd>
        </dl>
        <div class="sub-h">Element stiffness [kᵉ] <span style="text-transform:none">(${state.s.mtxUnit})</span></div>${ke}
        <p class="note">EA/L = ${fmt(mr.k / ku, 6)} ${state.s.mtxUnit}, c = cos θ = ${fmt(mr.c, 6)}, s = sin θ = ${fmt(mr.s, 6)}</p>`;
      return;
    }
    if (ns.length + ms.length > 1 && ms.length) {
      let fmax = 0, sfmin = Infinity;
      ms.forEach((e) => { const mr = memberRes(r, e); if (mr) { fmax = Math.max(fmax, Math.abs(mr.force)); sfmin = Math.min(sfmin, mr.sf); } });
      box.innerHTML = `<div class="sub-h">Selected members</div><dl class="kv"><dt>max |F|</dt><dd>${fF(fmax)} ${fu}</dd><dt>min SF</dt><dd>${fmt(sfmin, 4)}</dd></dl>`;
      return;
    }
    box.innerHTML = '';
  }
  function memberGeometry(e) {
    const dx = e.n2.x - e.n1.x, dy = e.n2.y - e.n1.y, L = Math.hypot(dx, dy);
    const g = e.group;
    return `<div class="sub-h">Geometry &amp; properties</div><dl class="kv">
      <dt>Length L</dt><dd>${fmt(L, 7)} m</dd>
      <dt>Angle θ</dt><dd>${fmt(Math.atan2(dy, dx) / D2R, 6)}°</dd>
      <dt>Material</dt><dd>${esc(g.material.name)}</dd>
      <dt>E, σ<sub>y</sub></dt><dd>${fmt(g.material.E / GPA)} GPa, ${fmt(g.material.fy / MPA)} MPa</dd>
      <dt>A, I</dt><dd>${fmt(g.A / MM2)} mm², ${fmt(g.I / MM4)} mm⁴</dd>
    </dl>`;
  }

  /* =====================================================================
   * 12. Status pill, banner, legend, health report
   * ===================================================================== */
  function refreshResults() {
    refreshStatus();
    renderHealth();
    renderInspectorResults();
    renderLegend();
    renderTablesIfVisible();
    refreshCounts();
  }
  function refreshCounts() {
    const M = state.model;
    $('#sbCounts').textContent = `${plural(M.nodes.length, 'node')} · ${plural(M.members.length, 'member')} · ${2 * M.nodes.length} DOF`;
  }
  function firstMsg(r) { return r.errors && r.errors.length ? r.errors[0].msg : ''; }
  function refreshStatus() {
    const pill = $('#statusPill'), banner = $('#banner');
    const r = state.res, live = state.s.liveSolve;
    let cls = '', text = 'Ready', bcls = '', btext = '';
    if (!state.model.members.length) {
      text = 'Empty model';
      bcls = 'info'; btext = 'Start drawing: press <kbd>N</kbd> to place nodes and <kbd>M</kbd> to connect them, or choose one of the <b>Examples…</b>';
    } else if (state.stale && !live) {
      cls = 'warn'; text = 'Results out of date: press Solve';
    } else if (!r) {
      text = 'Not analysed';
    } else if (!r.ok) {
      if (r.mechanism) {
        cls = 'bad'; text = `UNSTABLE: ${plural(r.mechanism.nullity, 'mechanism mode')}`;
        const mode = r.mechanism.modes[state.mechMode];
        bcls = 'bad';
        btext = `<span>⚠ <b>Unstable structure</b>: mode ${state.mechMode + 1}/${r.mechanism.modes.length} animated. ${esc(mode ? mode.description : '')}</span>` +
          (r.mechanism.modes.length > 1 ? '<button class="btn sm" id="btnNextMode">Next mode</button>' : '');
      } else {
        cls = 'warn'; text = 'Cannot analyse model';
        bcls = 'warn'; btext = `<span>${esc(firstMsg(r))}</span>`;
      }
    } else {
      const sm = r.summary;
      if (sm.failures.length) { cls = 'bad'; text = `${plural(sm.failures.length, 'member')} failed · SF min ${fmt(sm.minSF.value, 3)}`; }
      else if (sm.counts.low) { cls = 'warn'; text = `Solved · SF min ${fmt(sm.minSF.value, 3)} < target ${fmt(state.s.targetSF, 3)}`; }
      else { cls = 'ok'; text = `Solved · all members safe · SF min ${fmt(sm.minSF.value, 3)}`; }
    }
    pill.className = `pill ${cls}`;
    pill.textContent = text;
    pill.title = text;
    banner.hidden = !btext;
    banner.className = `banner ${bcls}`;
    banner.innerHTML = btext;
    const nb = $('#btnNextMode');
    if (nb) nb.addEventListener('click', () => { state.mechMode = (state.mechMode + 1) % r.mechanism.modes.length; refreshStatus(); requestRender(); });
    $('#sbTime').textContent = r && !state.stale ? `solve ${fmt(r.wall, 3)} ms` : '';
  }
  function renderLegend() {
    const lg = $('#legend');
    const r = R();
    if (!r || !r.ok || !state.s.showDeformed) { lg.hidden = true; return; }
    const by = state.s.colorBy;
    const mx = colorScaleMax(r);
    let title, lo, hi;
    if (by === 'util') { title = 'Utilisation 1/SF'; lo = 'C 100%'; hi = 'T 100%'; }
    else if (by === 'stress') { title = 'Axial stress σ'; lo = `${fmt(-mx / MPA, 3)} MPa`; hi = `${fmt(mx / MPA, 3)} MPa`; }
    else { title = 'Axial force F'; lo = `${fmt(-mx / fU(), 3)} ${state.s.forceUnit}`; hi = `${fmt(mx / fU(), 3)} ${state.s.forceUnit}`; }
    lg.innerHTML = `<div class="lg-title"><span>${title}</span><span>×${fmt(state.s.scale, 3)}</span></div>
      <div class="lg-bar"></div><div class="lg-scale"><span>${lo}</span><span>0</span><span>${hi}</span></div>
      <div class="lg-keys"><span><i style="background:#ef4444"></i>Compression</span><span><i style="background:#3b82f6"></i>Tension</span><span><i style="background:#6b7280"></i>Zero</span></div>`;
    lg.hidden = false;
  }
  function renderHealth() {
    const box = $('#health');
    const r = state.res, fu = state.s.forceUnit, du = state.s.dispUnit;
    const msgs = (list, cls) => list.map((m) => `<li class="${cls}${m.ref ? ' link' : ''}" ${m.ref ? `data-ref="${m.ref.type}:${m.ref.index}"` : ''}>${esc(m.msg)}</li>`).join('');
    if (!r || (state.stale && !state.s.liveSolve)) {
      box.innerHTML = `<div class="health-status idle"><span class="ic">○</span><div>${!r ? 'No analysis yet' : 'Results out of date'}<small>Press Solve (Enter) or turn on Live.</small></div></div>`;
      return;
    }
    let h = '';
    if (!r.ok) {
      if (r.mechanism) {
        h += `<div class="health-status bad"><span class="ic">✕</span><div>UNSTABLE: kinematic mechanism<small>The reduced stiffness matrix is singular; no unique solution exists.</small></div></div>`;
        h += `<div class="sub-h">Mechanism modes</div><ul class="msg-list">${r.mechanism.modes.map((m, i) => `<li class="e link" data-mode="${i}">Mode ${i + 1} (${m.kind}): ${esc(m.description)}</li>`).join('')}</ul>`;
      } else {
        h += `<div class="health-status warn"><span class="ic">!</span><div>Model cannot be analysed<small>Fix the issues below.</small></div></div>`;
      }
      h += stabilityBlock(r);
      if (r.errors.length) h += `<div class="sub-h">Errors</div><ul class="msg-list">${msgs(r.errors.filter((m) => !r.mechanism || !/kinematically unstable/.test(m.msg)), 'e')}</ul>`;
      if (r.warnings.length) h += `<div class="sub-h">Warnings</div><ul class="msg-list">${msgs(r.warnings, 'w')}</ul>`;
      box.innerHTML = h;
      bindHealth(box);
      return;
    }
    const sm = r.summary, c = sm.counts, fref = sm.Fref;
    const mNo = (k) => `M${k + 1}`;
    if (sm.failures.length) h += `<div class="health-status bad"><span class="ic">✕</span><div>${plural(sm.failures.length, 'member')} exceed capacity<small>${c.yielded} yielded · ${c.buckled} buckled</small></div></div>`;
    else if (c.low) h += `<div class="health-status warn"><span class="ic">!</span><div>Safe, but ${plural(c.low, 'member')} below target SF ${fmt(state.s.targetSF, 3)}<small>Governing SF ${fmt(sm.minSF.value, 3)} (${sm.minSF.governs})</small></div></div>`;
    else h += `<div class="health-status ok"><span class="ic">✓</span><div>Stable · all members within limits<small>Governing SF ${fmt(sm.minSF.value, 3)}${sm.minSF.member >= 0 ? ` at ${mNo(sm.minSF.member)} (${sm.minSF.governs})` : ''}</small></div></div>`;
    const sfCls = sm.minSF.value < 1 ? 'bad' : sm.minSF.value < state.s.targetSF ? 'warn' : 'ok';
    const pk = sm.peakStress;
    h += `<dl class="kv">
      <dt>Max deflection</dt><dd>${fD(sm.maxDisp.value)} ${du} <small>N${sm.maxDisp.node + 1}${Number.isFinite(sm.spanRatio) ? ` · span/${fmt(sm.spanRatio, 3)}` : ''}</small></dd>
      <dt>Max |u<sub>x</sub>|, |u<sub>y</sub>|</dt><dd>${fD(Math.abs(sm.maxUx.value))}, ${fD(Math.abs(sm.maxUy.value))} ${du}</dd>
      <dt>Peak stress</dt><dd>${pk.member >= 0 ? `${fS(pk.value)} MPa <small>${mNo(pk.member)} ${pk.value > 0 ? 'T' : 'C'}</small>` : '0'}</dd>
      <dt>Peak tension</dt><dd>${sm.maxTension.member >= 0 ? `${fF(sm.maxTension.value)} ${fu} <small>${mNo(sm.maxTension.member)}</small>` : '\u2014'}</dd>
      <dt>Peak compression</dt><dd>${sm.maxCompression.member >= 0 ? `${fF(sm.maxCompression.value)} ${fu} <small>${mNo(sm.maxCompression.member)}</small>` : '\u2014'}</dd>
      <dt>Critical SF</dt><dd class="${sfCls}">${fmt(sm.minSF.value, 4)}${sm.minSF.member >= 0 ? ` <small>${mNo(sm.minSF.member)} · ${sm.minSF.governs}</small>` : ''}</dd>
      <dt>Members</dt><dd>${c.tension} T · ${c.compression} C · ${c.zero} zero</dd>
      <dt>Status</dt><dd>${c.safe} safe · <span class="${c.yielded ? 'check-bad' : ''}">${c.yielded} yielded</span> · <span class="${c.buckled ? 'check-bad' : ''}">${c.buckled} buckled</span></dd>
    </dl>`;
    h += `<div class="sub-h">Buckling risk <span style="text-transform:none">(P<sub>cr</sub>/|F| &lt; ${fmt(Math.max(state.s.targetSF, 1), 3)})</span></div>`;
    if (sm.bucklingRisk.length) {
      h += `<ul class="risk-list">${sm.bucklingRisk.slice(0, 12).map((b) => {
        const mr = r.members[b.member];
        return `<li data-ref="member:${b.member}" title="Select member"><span>${mNo(b.member)} · |F| ${fF(-mr.force, fref)} / P<sub>cr</sub> ${fF(mr.Pcr)} ${fu}</span><span class="${b.sf < 1 ? 'bad' : 'warn'}">SF ${fmt(b.sf, 3)}</span></li>`;
      }).join('')}</ul>${sm.bucklingRisk.length > 12 ? `<p class="note">… and ${sm.bucklingRisk.length - 12} more</p>` : ''}`;
    } else h += '<p class="note">No compression member is close to its Euler load.</p>';
    if (sm.failures.length) {
      h += `<div class="sub-h">Failed members</div><ul class="risk-list">${sm.failures.slice(0, 12).map((k) => {
        const mr = r.members[k];
        return `<li data-ref="member:${k}"><span>${mNo(k)} · ${mr.status} · σ ${fS(mr.stress)} MPa</span><span class="bad">SF ${fmt(mr.sf, 3)}</span></li>`;
      }).join('')}</ul>`;
    }
    h += stabilityBlock(r);
    if (r.warnings.length) h += `<div class="sub-h">Warnings</div><ul class="msg-list">${msgs(r.warnings, 'w')}</ul>`;
    box.innerHTML = h;
    bindHealth(box);
  }
  function stabilityBlock(r) {
    const D = r.diagnostics || {};
    let h = '<div class="sub-h">Stability &amp; numerical verification</div><dl class="kv small">';
    if (r.determinacy) {
      const d = r.determinacy;
      const cls = d.degree < 0 ? 'unstable' : d.degree === 0 ? 'determinate' : `indeterminate (${d.degree}°)`;
      h += `<dt>Maxwell m + r − 2j</dt><dd>${d.m} + ${d.r} − ${2 * d.j} = ${d.degree} <small>${cls}</small></dd>`;
    }
    if (D.rank !== undefined) h += `<dt>Rank [K<sub>ff</sub>]</dt><dd class="${D.nullity ? 'bad' : 'ok'}">${D.rank} / ${D.nf} ${D.nullity ? '✕' : '✓'}</dd>`;
    if (Number.isFinite(D.minPivot)) h += `<dt>Min. scaled pivot</dt><dd>${fmt(D.minPivot, 3)} <small>tol ${fmt(D.pivotTol, 2)}</small></dd>`;
    if (D.detRaw && r.ok && D.nf > 0) {
      h += `<dt>det [K<sub>ff</sub>]</dt><dd>${fmt(D.detRaw.mantissa, 5)}e${D.detRaw.exponent} <small>(N/m)<sup>${D.nf}</sup></small></dd>`;
      h += `<dt>det [K̃] (scaled)</dt><dd>${fmt(D.detScaled.mantissa, 5)}e${D.detScaled.exponent} <small>∈ (0, 1]</small></dd>`;
      h += `<dt>LU vs Cholesky det</dt><dd>${fmt(D.detAgreement, 2)} <small>rel. diff.</small></dd>`;
    } else if (D.detRaw && r.mechanism) h += '<dt>det [K<sub>ff</sub>]</dt><dd class="bad">0 (singular)</dd>';
    if (r.ok && D.nf > 0) {
      h += `<dt>κ₁(K̃) ${D.condMethod === 'estimate' ? 'est.' : 'exact'}</dt><dd class="${D.cond1Scaled > 1e10 ? 'warn' : ''}">${fmt(D.cond1Scaled, 3)} <small>κ₁(K<sub>ff</sub>) ${fmt(D.cond1Raw, 3)}</small></dd>`;
      h += `<dt>Backward error</dt><dd>${fmt(D.backwardError, 2)} <small>${plural(D.refineIterations, 'refinement')}</small></dd>`;
    }
    if (r.ok && D.equilibrium) {
      // round-off in assembled stiffness entries scales with model size, so 1e-8 relative is "exact" here
      const e = D.equilibrium, okEq = Math.max(e.relF, e.relM) < 1e-8;
      h += `<dt>ΣF<sub>x</sub>, ΣF<sub>y</sub></dt><dd>${fmt(e.sumFx, 2)}, ${fmt(e.sumFy, 2)} N</dd>`;
      h += `<dt>ΣM (centroid)</dt><dd>${fmt(e.sumM, 2)} N·m</dd>`;
      h += `<dt>Equilibrium</dt><dd class="${okEq ? 'ok' : 'bad'}">${okEq ? '✓' : '✕'} rel. ${fmt(Math.max(e.relF, e.relM), 2)}</dd>`;
      h += `<dt>Nodal equilibrium</dt><dd class="${D.nodalResidualRel < 1e-8 ? 'ok' : 'bad'}">${D.nodalResidualRel < 1e-8 ? '✓' : '✕'} rel. ${fmt(D.nodalResidualRel, 2)}</dd>`;
    }
    return h + '</dl>';
  }
  function bindHealth(box) {
    box.querySelectorAll('[data-ref]').forEach((el) => el.addEventListener('click', () => {
      const [type, idx] = el.dataset.ref.split(':');
      const obj = type === 'node' ? state.model.nodes[+idx] : state.model.members[+idx];
      if (obj) selectOnly(type, obj);
    }));
    box.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', () => { state.mechMode = +el.dataset.mode; refreshStatus(); requestRender(); }));
  }

  /* =====================================================================
   * 13. Bottom panel: tables, stiffness matrix inspector, solver log
   * ===================================================================== */
  function renderTablesIfVisible() {
    if (state.s.bottomCollapsed) return;
    const t = state.s.bottomTab;
    if (t === 'members') renderMembersTable();
    else if (t === 'nodes') renderNodesTable();
    else if (t === 'matrix') renderMatrix();
    else if (t === 'log') renderLog();
  }
  function renderAllPanels() { renderLeftLists(); renderInspector(); refreshResults(); }

  function sortRows(rows, sort, keyFn) {
    const k = sort.key, d = sort.dir;
    if (k === 'id') return d > 0 ? rows : rows.slice().reverse();
    return rows.slice().sort((a, b) => {
      const va = keyFn(a, k), vb = keyFn(b, k);
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * d;
      const x = Number.isFinite(va) ? va : (va > 0 ? 1e308 : -1e308), y = Number.isFinite(vb) ? vb : (vb > 0 ? 1e308 : -1e308);
      return (x - y) * d;
    });
  }
  function header(cols, sort) {
    return `<thead><tr>${cols.map(([k, label, cls]) => `<th data-sort="${k}" class="${cls || ''} ${sort.key === k ? 'sorted' + (sort.dir > 0 ? ' asc' : '') : ''}">${label}</th>`).join('')}</tr></thead>`;
  }
  function bindTable(box, which, kind) {
    box.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const s = state.sort[which];
      if (s.key === th.dataset.sort) s.dir = -s.dir; else { s.key = th.dataset.sort; s.dir = 1; }
      renderTablesIfVisible();
    }));
    box.querySelectorAll('tbody tr').forEach((tr) => {
      const obj = (kind === 'node' ? state.model.nodes : state.model.members)[+tr.dataset.i];
      tr.addEventListener('click', (e) => { if (e.shiftKey) toggleSel(kind, obj); else selectOnly(kind, obj); });
      tr.addEventListener('mouseenter', () => { state.tableHover = obj; requestRender(); });
      tr.addEventListener('mouseleave', () => { state.tableHover = null; requestRender(); });
    });
  }
  function renderMembersTable() {
    const box = $('#tab-members');
    const M = state.model, r = R();
    const ok = r && r.ok, fu = state.s.forceUnit, du = state.s.dispUnit;
    if (!M.members.length) { box.innerHTML = '<div class="empty">No members yet. Press M and click two nodes.</div>'; $('#tabInfo').textContent = ''; return; }
    const rows = M.members.map((e, i) => ({ e, i, mr: ok ? memberRes(r, e) : null }));
    const key = (row, k) => {
      const mr = row.mr, e = row.e;
      switch (k) {
        case 'L': return Math.hypot(e.n2.x - e.n1.x, e.n2.y - e.n1.y);
        case 'th': return Math.atan2(e.n2.y - e.n1.y, e.n2.x - e.n1.x);
        case 'grp': return e.group.name;
        case 'F': return mr ? mr.force : 0;
        case 'sig': return mr ? mr.stress : 0;
        case 'eps': return mr ? mr.strain : 0;
        case 'dl': return mr ? mr.elong : 0;
        case 'pcr': return mr ? mr.Pcr : 0;
        case 'sf': return mr ? mr.sf : Infinity;
        case 'st': return mr ? ({ buckled: 0, yielded: 1, safe: 2 }[mr.status] + (mr.lowSF ? 0.5 : 0)) : 3;
        default: return row.i;
      }
    };
    const sorted = sortRows(rows, state.sort.members, key);
    const ref = ok ? r.summary.Fref : 0;
    const cols = [['id', '#', 'l'], ['nodes', 'Nodes', 'l'], ['grp', 'Section', 'l'], ['L', 'L [m]'], ['th', 'θ [°]'], ['F', `F [${fu}]`], ['sig', 'σ [MPa]'], ['eps', 'ε [–]'], ['dl', `ΔL [${du}]`], ['pcr', `P<sub>cr</sub> [${fu}]`], ['sf', 'SF'], ['st', 'Status', 'l']];
    let h = `<table class="data">${header(cols, state.sort.members)}<tbody>`;
    for (const { e, i, mr } of sorted) {
      const L = Math.hypot(e.n2.x - e.n1.x, e.n2.y - e.n1.y), th = Math.atan2(e.n2.y - e.n1.y, e.n2.x - e.n1.x) / D2R;
      const cls = mr ? (mr.state === 'zero' ? 'z' : mr.force > 0 ? 't' : 'c') : '';
      const z = mr && mr.state === 'zero';
      h += `<tr data-i="${i}" class="${state.sel.members.has(e) ? 'sel' : ''}">
        <td class="l">M${i + 1}</td><td class="l">N${nodeNo(e.n1)}–N${nodeNo(e.n2)}</td>
        <td class="l"><span class="swatch" style="display:inline-block;vertical-align:-1px;background:${esc(e.group.color)}"></span> ${esc(e.group.name)}</td>
        <td>${fmt(L, 6)}</td><td>${fmt(th, 5)}</td>
        <td class="${cls}">${mr ? (z ? '0' : fF(mr.force, ref)) : '—'}</td>
        <td class="${cls}">${mr ? (z ? '0' : fS(mr.stress)) : '—'}</td>
        <td class="${cls}">${mr ? (z ? '0' : fmt(mr.strain)) : '—'}</td>
        <td class="${cls}">${mr ? (z ? '0' : fD(mr.elong)) : '—'}</td>
        <td>${mr ? fF(mr.Pcr) : '—'}</td>
        <td>${mr ? fmt(mr.sf, 4) : '—'}</td>
        <td class="l">${mr ? statusBadge(mr) : r && r.mechanism ? '<span class="badge unstable">Unstable</span>' : '—'}</td></tr>`;
    }
    box.innerHTML = h + '</tbody></table>';
    bindTable(box, 'members', 'member');
    $('#tabInfo').textContent = ok ? `T > 0 · C < 0 · SF = min(σy/|σ|, Pcr/|F|) · λ = ${fmt(state.s.loadFactor, 4)}` : '';
  }
  function renderNodesTable() {
    const box = $('#tab-nodes');
    const M = state.model, r = R(), ok = r && r.ok;
    const fu = state.s.forceUnit, du = state.s.dispUnit;
    if (!M.nodes.length) { box.innerHTML = '<div class="empty">No nodes yet. Press N and click on the canvas.</div>'; return; }
    const rows = M.nodes.map((n, i) => ({ n, i, nr: ok ? nodeRes(r, n) : null }));
    const key = (row, k) => {
      const n = row.n, nr = row.nr;
      switch (k) {
        case 'x': return n.x; case 'y': return n.y; case 'sup': return supportText(n.support);
        case 'fx': return n.load.fx; case 'fy': return n.load.fy;
        case 'ux': return nr ? nr.ux : 0; case 'uy': return nr ? nr.uy : 0; case 'u': return nr ? nr.u : 0;
        case 'rx': return nr ? nr.rx : 0; case 'ry': return nr ? nr.ry : 0;
        default: return row.i;
      }
    };
    const sorted = sortRows(rows, state.sort.nodes, key);
    const dref = ok ? r.summary.maxDisp.value : 0, fref = ok ? r.summary.Fref : 0, lf = state.s.loadFactor;
    const cols = [['id', '#', 'l'], ['x', 'x [m]'], ['y', 'y [m]'], ['sup', 'Support', 'l'], ['fx', `F<sub>x</sub>·λ [${fu}]`], ['fy', `F<sub>y</sub>·λ [${fu}]`], ['ux', `u<sub>x</sub> [${du}]`], ['uy', `u<sub>y</sub> [${du}]`], ['u', `|u| [${du}]`], ['rx', `R<sub>x</sub> [${fu}]`], ['ry', `R<sub>y</sub> [${fu}]`]];
    let h = `<table class="data">${header(cols, state.sort.nodes)}<tbody>`;
    for (const { n, i, nr } of sorted) {
      const sup = nr && (nr.restrained[0] || nr.restrained[1]);
      h += `<tr data-i="${i}" class="${state.sel.nodes.has(n) ? 'sel' : ''}">
        <td class="l">N${i + 1}</td><td>${fmt(n.x, 6)}</td><td>${fmt(n.y, 6)}</td><td class="l">${esc(supportText(n.support))}</td>
        <td>${n.load.fx ? fF(n.load.fx * lf) : '<span class="dim">0</span>'}</td><td>${n.load.fy ? fF(n.load.fy * lf) : '<span class="dim">0</span>'}</td>
        <td>${nr ? fD(nr.ux, dref) : '—'}</td><td>${nr ? fD(nr.uy, dref) : '—'}</td><td>${nr ? fD(nr.u, dref) : '—'}</td>
        <td>${sup ? fF(nr.rx, fref) : '<span class="dim">—</span>'}</td><td>${sup ? fF(nr.ry, fref) : '<span class="dim">—</span>'}</td></tr>`;
    }
    if (ok) {
      let sx = 0, sy = 0;
      for (const nr of r.nodes) { sx += nr.rx; sy += nr.ry; }
      h += `<tr class="dim"><td class="l" colspan="9">Σ reactions (should balance Σ loads)</td><td>${fF(sx, fref)}</td><td>${fF(sy, fref)}</td></tr>`;
    }
    box.innerHTML = h + '</tbody></table>';
    bindTable(box, 'nodes', 'node');
    $('#tabInfo').textContent = ok ? 'Displacements and reactions in global axes. Positive = +x right, +y up' : '';
  }

  /* ---------- stiffness matrix inspector ---------- */
  function matrixData() {
    const r = state.res;
    if (!r || !r.K) return { msg: r ? `Matrices are not available: ${firstMsg(r) || 'fix the validation errors first.'}` : 'Run an analysis first.' };
    const v = state.s.mtxView;
    const ndof = r.ndof;
    const fixedSet = new Set(r.fixed ? Array.from(r.fixed) : []);
    if (v === 'global' || v === 'transformed') {
      const M = v === 'transformed' ? r.Kt : r.K;
      return {
        M, n: ndof, labels: r.dofLabels, fixed: (i) => fixedSet.has(i),
        title: v === 'transformed' ? (r.rotated.length ? 'Rotated global matrix [K′] = Λ[K]Λᵀ (inclined support frames)' : 'No inclined supports: [K′] = [K]') : 'Assembled global stiffness matrix [K] (global x, y axes)',
        legend: 'Amber headers = restrained DOFs. Highlighted cells = diagonal.',
      };
    }
    if (v === 'reduced') {
      const nf = r.nf, lab = Array.from(r.free || [], (d) => r.dofLabels[d]);
      const vec = [];
      if (r.bf) vec.push({ name: `F<sub>eff</sub> [${state.s.forceUnit}]`, vals: r.bf, unit: fU() });
      if (r.ok && r.ut) vec.push({ name: `u<sub>f</sub> [${state.s.dispUnit}]`, vals: Array.from(r.free, (d) => r.ut[d]), unit: dU() });
      return { M: r.Kff, n: nf, labels: lab, fixed: () => false, vec, title: `Reduced stiffness matrix [K<sub>ff</sub>] (free DOFs): [K<sub>ff</sub>]{u<sub>f</sub>} = {F<sub>f</sub>} − [K<sub>fs</sub>]{u<sub>s</sub>}`, legend: 'F<sub>eff</sub> includes the effect of prescribed displacements. DOFs marked ′ are in a rotated support frame.' };
    }
    const e = [...state.sel.members][0];
    const i = e && r.memberIndex ? r.memberIndex.get(e) : undefined;
    if (i === undefined || !r.members[i]) return { msg: 'Select one member (V, then click it) to see its element stiffness matrix.' };
    const mr = r.members[i];
    return { M: mr.ke, n: 4, labels: mr.dofs.map((d) => r.dofLabels[d]), fixed: () => false, title: `Element stiffness matrix [kᵉ] of M${i + 1} (global axes): EA/L = ${fmt(mr.k / (STIFF_UNITS[state.s.mtxUnit] || 1), 6)} ${state.s.mtxUnit}, c = ${fmt(mr.c, 6)}, s = ${fmt(mr.s, 6)}`, legend: '' };
  }
  function renderMatrix() {
    syncSettingsUI();
    const view = $('#mtxView'), info = $('#mtxInfo');
    const d = matrixData();
    $('#segMatrix button[data-mtx="transformed"]').disabled = !(state.res && state.res.rotated && state.res.rotated.length);
    if (d.msg) { view.innerHTML = `<div class="empty">${esc(d.msg)}</div>`; info.textContent = ''; $('#tabInfo').textContent = ''; return; }
    const unit = STIFF_UNITS[state.s.mtxUnit] || 1;
    let nnz = 0, sym = true;
    for (let a = 0; a < d.n; a++) for (let b = 0; b < d.n; b++) { if (d.M[a * d.n + b] !== 0) nnz++; if (b > a && d.M[a * d.n + b] !== d.M[b * d.n + a]) sym = false; }
    info.innerHTML = `${d.n} × ${d.n} · ${nnz} non-zeros · ${sym ? 'exactly symmetric' : 'not symmetric'}`;
    $('#tabInfo').textContent = `values in ${state.s.mtxUnit}`;
    const mode = d.n > 120 ? 'heatmap' : state.s.mtxMode;
    let maxAbsV = 0;
    for (let k = 0; k < d.n * d.n; k++) maxAbsV = Math.max(maxAbsV, Math.abs(d.M[k]));
    if (mode === 'table') {
      const dim = state.s.mtxDimZeros;
      let h = `<div class="mtx-legend"><b>${d.title}</b><br>${d.legend || ''}</div><table class="mtx"><thead><tr><th class="corner rh"></th>`;
      d.labels.forEach((l, j) => { h += `<th class="${d.fixed(j) ? 'fix' : ''}">${l}</th>`; });
      if (d.vec) d.vec.forEach((v) => { h += `<th class="vec">${v.name}</th>`; });
      h += '</tr></thead><tbody>';
      for (let a = 0; a < d.n; a++) {
        h += `<tr><th class="rh ${d.fixed(a) ? 'fix' : ''}">${d.labels[a]}</th>`;
        for (let b = 0; b < d.n; b++) {
          const v = chop(d.M[a * d.n + b], maxAbsV);
          const cls = [a === b ? 'diag' : '', v === 0 && dim ? 'zero' : '', v < 0 ? 'neg' : '', d.fixed(a) || d.fixed(b) ? 'fixcell' : ''].join(' ');
          h += `<td class="${cls}">${v === 0 ? (dim ? '·' : '0') : fmt(v / unit)}</td>`;
        }
        if (d.vec) d.vec.forEach((v) => { h += `<td class="vec">${fmt(v.vals[a] / v.unit)}</td>`; });
        h += '</tr>';
      }
      view.innerHTML = h + '</tbody></table>';
    } else renderHeatmap(view, d, unit, maxAbsV);
  }
  function renderHeatmap(view, d, unit, maxAbsV) {
    const avail = Math.max(200, Math.min(view.clientWidth - 320, 900));
    const cell = clamp(Math.floor(avail / d.n), 2, 26);
    const size = cell * d.n;
    view.innerHTML = `<div class="mtx-legend"><b>${d.title}</b><br>Colour = sign (red −, blue +), brightness = log₁₀|k| over 8 decades. ${d.n > 120 ? 'Table view is limited to 120 DOFs.' : ''}</div>
      <div class="heat-wrap"><canvas width="${size}" height="${size}" style="width:${size}px;height:${size}px"></canvas><div class="heat-readout">Hover a cell to read K[i, j].</div></div>`;
    const cv = view.querySelector('canvas'), c2 = cv.getContext('2d'), ro = view.querySelector('.heat-readout');
    c2.fillStyle = '#0b1118'; c2.fillRect(0, 0, size, size);
    const lmax = Math.log10(maxAbsV || 1);
    for (let a = 0; a < d.n; a++) for (let b = 0; b < d.n; b++) {
      const v = d.M[a * d.n + b];
      if (v === 0 || Math.abs(v) <= 1e-12 * maxAbsV) continue;
      const t = clamp((Math.log10(Math.abs(v)) - lmax + 8) / 8, 0.08, 1);
      c2.fillStyle = v > 0 ? `rgba(59,130,246,${t})` : `rgba(239,68,68,${t})`;
      if (a === b) c2.fillStyle = `rgba(56,189,248,${Math.max(t, 0.5)})`;
      c2.fillRect(b * cell, a * cell, cell, cell);
    }
    cv.addEventListener('mousemove', (ev) => {
      const rc = cv.getBoundingClientRect();
      const b = Math.floor((ev.clientX - rc.left) / cell), a = Math.floor((ev.clientY - rc.top) / cell);
      if (a < 0 || b < 0 || a >= d.n || b >= d.n) return;
      const v = d.M[a * d.n + b];
      ro.innerHTML = `K[${d.labels[a]}, ${d.labels[b]}]<br><b style="color:#e2e8f0">${fmt(v / unit, 8)}</b> ${state.s.mtxUnit}<br><span class="dim">row ${a + 1}, column ${b + 1}</span>`;
    });
  }
  function renderLog() {
    const r = state.res;
    const pre = $('#logText');
    if (!r) { pre.textContent = 'No analysis has been run yet.'; return; }
    const lines = [`<span class="s">TrussLab solver ${esc(FEA.VERSION)}, ${new Date().toLocaleString()} · load factor λ = ${r.loadFactor} · wall time ${fmt(r.wall, 3)} ms</span>`, ''];
    r.log.forEach((l, i) => lines.push(`<span class="s">[${String(i + 1).padStart(2, '0')}]</span> ${esc(l)}`));
    if (r.warnings.length) { lines.push(''); r.warnings.forEach((w) => lines.push(`<span class="w">WARNING  ${esc(w.msg)}</span>`)); }
    if (r.errors.length) { lines.push(''); r.errors.forEach((e) => lines.push(`<span class="e">ERROR    ${esc(e.msg)}</span>`)); }
    if (r.ok && r.diagnostics.backwardErrorHistory) {
      lines.push('', `<span class="s">Refinement history (normwise backward error): ${r.diagnostics.backwardErrorHistory.map((x) => x.toExponential(2)).join(' → ')}</span>`);
    }
    pre.innerHTML = lines.join('\n');
    $('#tabInfo').textContent = '';
  }

  /* =====================================================================
   * 14. Export
   * ===================================================================== */
  function download(name, mime, content) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const baseName = () => (state.model.title || 'truss').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 40) || 'truss';
  const cnum = (v) => (v === Infinity ? 'inf' : v === -Infinity ? '-inf' : typeof v === 'number' ? (Number.isNaN(v) ? '' : String(v)) : v);
  const csvCell = (v) => { const s = String(cnum(v)); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csvRow = (arr) => arr.map(csvCell).join(',');
  const jnum = (v) => (Number.isFinite(v) ? v : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : null);
  function requireResults(needOk) {
    const r = state.res;
    if (!r || (state.stale && !state.s.liveSolve)) { solve(false); }
    const r2 = state.res;
    if (!r2) { toast('No analysis results available', 'bad'); return null; }
    if (needOk && !r2.ok) toast('Exporting an incomplete report: ' + (r2.mechanism ? 'the structure is unstable.' : 'the model has errors.'), 'warn');
    return r2;
  }
  function reportObject(r) {
    const M = state.model;
    const D = r.diagnostics || {};
    const obj = {
      meta: { app: 'TrussLab 2D Truss FEA & Load Simulator', solver: FEA.VERSION, generated: new Date().toISOString(), units: 'SI base units: m, N, Pa, m^2, m^4; angles in degrees', loadFactor: r.loadFactor, targetSF: state.s.targetSF },
      model: serialize(M),
      status: r.ok ? 'solved' : r.mechanism ? 'unstable' : 'invalid',
      errors: r.errors.map((e) => e.msg), warnings: r.warnings.map((w) => w.msg),
      determinacy: r.determinacy || null,
      diagnostics: {
        freeDOFs: D.nf, restrainedDOFs: D.ns, rank: D.rank, nullity: D.nullity, minScaledPivot: jnum(D.minPivot),
        determinantKff: D.detRaw ? { log10: jnum(D.detRaw.log10), mantissa: jnum(D.detRaw.mantissa), exponent: D.detRaw.exponent } : null,
        determinantScaled: D.detScaled ? { log10: jnum(D.detScaled.log10), mantissa: jnum(D.detScaled.mantissa), exponent: D.detScaled.exponent } : null,
        cond1Scaled: jnum(D.cond1Scaled), cond1Kff: jnum(D.cond1Raw), condMethod: D.condMethod,
        refinementSteps: D.refineIterations, backwardError: jnum(D.backwardError), equilibrium: D.equilibrium || null,
        nodalEquilibriumResidual_N: jnum(D.nodalResidual),
      },
      log: r.log,
    };
    if (r.ok) {
      const sm = r.summary;
      obj.summary = {
        maxDisplacement_m: sm.maxDisp.value, maxDisplacementNode: sm.maxDisp.node + 1, spanOverDeflection: jnum(sm.spanRatio),
        peakStress_Pa: sm.peakStress.value, peakStressMember: sm.peakStress.member + 1,
        maxTension_N: sm.maxTension.value, maxTensionMember: sm.maxTension.member + 1,
        maxCompression_N: sm.maxCompression.value, maxCompressionMember: sm.maxCompression.member + 1,
        criticalSF: jnum(sm.minSF.value), criticalMember: sm.minSF.member + 1, criticalMode: sm.minSF.governs,
        counts: sm.counts, bucklingRisk: sm.bucklingRisk.map((b) => ({ member: b.member + 1, sfBuckling: b.sf })),
      };
      obj.nodes = M.nodes.map((n, i) => {
        const nr = r.nodes[i];
        return { id: i + 1, x: n.x, y: n.y, support: supportText(n.support), Fx: n.load.fx * r.loadFactor, Fy: n.load.fy * r.loadFactor, ux: nr.ux, uy: nr.uy, u: nr.u, Rx: nr.rx, Ry: nr.ry };
      });
      obj.members = M.members.map((e, k) => {
        const mr = r.members[k];
        return {
          id: k + 1, nodeI: mr.i + 1, nodeJ: mr.j + 1, section: e.group.name, material: e.group.material.name,
          E: mr.E, A: mr.A, I: mr.I, fy: mr.fy, L: mr.L, angle_deg: mr.angle, EA_L: mr.k,
          elongation: mr.elong, strain: mr.strain, force: mr.force, stress: mr.stress, Pcr: mr.Pcr, slenderness: mr.slenderness,
          sfYield: jnum(mr.sfYield), sfBuckling: jnum(mr.sfBuckling), sf: jnum(mr.sf), governs: mr.governs, state: mr.state, status: mr.status,
        };
      });
    } else if (r.mechanism) {
      obj.mechanismModes = r.mechanism.modes.map((m, i) => ({ mode: i + 1, kind: m.kind, description: m.description, nodes: m.nodes.map((k) => k + 1), shape: Array.from(m.u) }));
    }
    return obj;
  }
  function exportReportJSON() { const r = requireResults(true); if (!r) return; download(`${baseName()}-report-${stamp()}.json`, 'application/json', JSON.stringify(reportObject(r), null, 2)); }
  function exportReportCSV() {
    const r = requireResults(true); if (!r) return;
    const o = reportObject(r);
    const L = [];
    L.push(csvRow(['# TrussLab 2D Truss FEA calculation report']));
    L.push(csvRow(['# generated', o.meta.generated]));
    L.push(csvRow(['# units', o.meta.units]));
    L.push(csvRow(['title', state.model.title]));
    L.push(csvRow(['status', o.status]));
    L.push(csvRow(['load factor', r.loadFactor]));
    L.push(csvRow(['target SF', state.s.targetSF]));
    o.errors.forEach((e) => L.push(csvRow(['error', e])));
    o.warnings.forEach((w) => L.push(csvRow(['warning', w])));
    L.push('');
    L.push('MATERIALS'); L.push(csvRow(['id', 'name', 'E_Pa', 'fy_Pa']));
    state.model.materials.forEach((m, i) => L.push(csvRow([i + 1, m.name, m.E, m.fy])));
    L.push(''); L.push('SECTIONS'); L.push(csvRow(['id', 'name', 'material', 'shape', 'A_m2', 'I_m4']));
    state.model.groups.forEach((g, i) => L.push(csvRow([i + 1, g.name, g.material.name, g.shape.type, g.A, g.I])));
    L.push(''); L.push('NODES');
    L.push(csvRow(['id', 'x_m', 'y_m', 'support', 'fix_x', 'fix_y', 'frame_angle_deg', 'prescribed_dx_m', 'prescribed_dy_m', 'Fx_N', 'Fy_N', 'ux_m', 'uy_m', 'u_m', 'Rx_N', 'Ry_N']));
    state.model.nodes.forEach((n, i) => {
      const s = supportDOF(n.support), nr = r.ok ? r.nodes[i] : null;
      L.push(csvRow([i + 1, n.x, n.y, supportText(n.support), s.fixX ? 1 : 0, s.fixY ? 1 : 0, s.angle, s.dx, s.dy, n.load.fx * r.loadFactor, n.load.fy * r.loadFactor,
        nr ? nr.ux : '', nr ? nr.uy : '', nr ? nr.u : '', nr ? nr.rx : '', nr ? nr.ry : '']));
    });
    L.push(''); L.push('MEMBERS');
    L.push(csvRow(['id', 'node_i', 'node_j', 'section', 'material', 'E_Pa', 'A_m2', 'I_m4', 'fy_Pa', 'L_m', 'theta_deg', 'EA_over_L_N_per_m', 'elongation_m', 'strain', 'force_N', 'stress_Pa', 'Pcr_N', 'slenderness', 'SF_yield', 'SF_buckling', 'SF', 'governs', 'state', 'status']));
    state.model.members.forEach((e, k) => {
      const mr = r.ok ? r.members[k] : null;
      const L0 = Math.hypot(e.n2.x - e.n1.x, e.n2.y - e.n1.y);
      L.push(csvRow([k + 1, nodeNo(e.n1), nodeNo(e.n2), e.group.name, e.group.material.name, e.group.material.E, e.group.A, e.group.I, e.group.material.fy,
        mr ? mr.L : L0, mr ? mr.angle : Math.atan2(e.n2.y - e.n1.y, e.n2.x - e.n1.x) / D2R, mr ? mr.k : '', mr ? mr.elong : '', mr ? mr.strain : '', mr ? mr.force : '', mr ? mr.stress : '',
        mr ? mr.Pcr : '', mr ? mr.slenderness : '', mr ? mr.sfYield : '', mr ? mr.sfBuckling : '', mr ? mr.sf : '', mr ? mr.governs : '', mr ? mr.state : '', mr ? mr.status : (r.mechanism ? 'unstable' : '')]));
    });
    if (o.summary) {
      L.push(''); L.push('SUMMARY'); L.push(csvRow(['quantity', 'value', 'location']));
      const s = o.summary;
      L.push(csvRow(['max displacement [m]', s.maxDisplacement_m, `N${s.maxDisplacementNode}`]));
      L.push(csvRow(['span / max displacement', s.spanOverDeflection, '']));
      L.push(csvRow(['peak stress [Pa]', s.peakStress_Pa, `M${s.peakStressMember}`]));
      L.push(csvRow(['max tension [N]', s.maxTension_N, s.maxTensionMember > 0 ? `M${s.maxTensionMember}` : '']));
      L.push(csvRow(['max compression [N]', s.maxCompression_N, s.maxCompressionMember > 0 ? `M${s.maxCompressionMember}` : '']));
      L.push(csvRow(['critical safety factor', s.criticalSF, s.criticalMember > 0 ? `M${s.criticalMember} (${s.criticalMode})` : '']));
      L.push(csvRow(['members yielded', s.counts.yielded, ''])); L.push(csvRow(['members buckled', s.counts.buckled, ''])); L.push(csvRow(['zero-force members', s.counts.zero, '']));
    }
    if (o.mechanismModes) {
      L.push(''); L.push('MECHANISM MODES'); L.push(csvRow(['mode', 'kind', 'description', 'nodes']));
      o.mechanismModes.forEach((m) => L.push(csvRow([m.mode, m.kind, m.description, m.nodes.join(' ')])));
    }
    L.push(''); L.push('DIAGNOSTICS'); L.push(csvRow(['quantity', 'value']));
    const d = o.diagnostics;
    if (o.determinacy) L.push(csvRow(['Maxwell m + r - 2j', o.determinacy.degree]));
    [['free DOFs', d.freeDOFs], ['restrained DOFs', d.restrainedDOFs], ['rank Kff', d.rank], ['nullity', d.nullity], ['min scaled pivot', d.minScaledPivot],
      ['log10 det Kff', d.determinantKff && d.determinantKff.log10], ['log10 det scaled', d.determinantScaled && d.determinantScaled.log10],
      ['kappa1 scaled', d.cond1Scaled], ['kappa1 Kff', d.cond1Kff], ['condition method', d.condMethod], ['refinement steps', d.refinementSteps], ['backward error', d.backwardError],
      ['sum Fx [N]', d.equilibrium && d.equilibrium.sumFx], ['sum Fy [N]', d.equilibrium && d.equilibrium.sumFy], ['sum M [N m]', d.equilibrium && d.equilibrium.sumM],
      ['nodal equilibrium residual [N]', d.nodalEquilibriumResidual_N]].forEach(([k, v]) => L.push(csvRow([k, v === undefined || v === null ? '' : v])));
    download(`${baseName()}-report-${stamp()}.csv`, 'text/csv', L.join('\r\n'));
  }
  function matrixToRows(M, n) { const rows = []; for (let a = 0; a < n; a++) rows.push(Array.from(M.subarray(a * n, a * n + n))); return rows; }
  function exportMatricesJSON() {
    const r = requireResults(false); if (!r) return;
    if (!r.K) { toast('Matrices are not available: ' + firstMsg(r), 'bad'); return; }
    const freeL = Array.from(r.free, (d) => r.dofLabels[d]);
    const o = {
      meta: { generated: new Date().toISOString(), units: 'K in N/m, F and R in N, u in m', loadFactor: r.loadFactor, note: 'DOF labels: node number + axis; a prime marks a rotated support frame' },
      dofLabels: r.dofLabels, K: matrixToRows(r.K, r.ndof),
      Krotated: r.rotated.length ? matrixToRows(r.Kt, r.ndof) : null,
      freeDOFs: freeL, restrainedDOFs: Array.from(r.fixed, (d) => r.dofLabels[d]),
      Kff: matrixToRows(r.Kff, r.nf), Feff: Array.from(r.bf || []),
      F: Array.from(r.F), u: r.ok ? Array.from(r.u) : null, R: r.ok ? Array.from(r.R) : null,
      elements: r.ok ? r.members.map((mr, k) => ({ id: k + 1, dofs: mr.dofs.map((d) => r.dofLabels[d]), ke: matrixToRows(mr.ke, 4) })) : null,
    };
    download(`${baseName()}-matrices-${stamp()}.json`, 'application/json', JSON.stringify(o));
  }
  function exportMatricesCSV() {
    const r = requireResults(false); if (!r) return;
    if (!r.K) { toast('Matrices are not available: ' + firstMsg(r), 'bad'); return; }
    const L = [];
    const block = (title, M, n, labels) => {
      L.push(csvRow([title])); L.push(csvRow(['DOF', ...labels]));
      for (let a = 0; a < n; a++) L.push(csvRow([labels[a], ...Array.from(M.subarray(a * n, a * n + n))]));
      L.push('');
    };
    L.push(csvRow(['# TrussLab system matrices', new Date().toISOString(), 'K in N/m; F, R in N; u in m', `load factor ${r.loadFactor}`]));
    L.push('');
    block('GLOBAL STIFFNESS MATRIX K [N/m]', r.K, r.ndof, r.dofLabels);
    if (r.rotated.length) block("ROTATED GLOBAL MATRIX K' = L K L^T [N/m]", r.Kt, r.ndof, r.dofLabels);
    const fl = Array.from(r.free, (d) => r.dofLabels[d]);
    block('REDUCED STIFFNESS MATRIX Kff [N/m]', r.Kff, r.nf, fl);
    L.push('VECTORS'); L.push(csvRow(['DOF', 'status', 'F_N', 'u_m', 'R_N']));
    const fixed = new Set(Array.from(r.fixed));
    for (let d = 0; d < r.ndof; d++) L.push(csvRow([r.dofLabels[d], r.active && !r.active[d >> 1] ? 'inactive' : fixed.has(d) ? 'restrained' : 'free', r.F[d], r.ok ? r.u[d] : '', r.ok ? r.R[d] : '']));
    download(`${baseName()}-matrices-${stamp()}.csv`, 'text/csv', L.join('\r\n'));
  }
  function exportPNG() {
    draw(performance.now());
    canvas.toBlob((b) => { if (b) download(`${baseName()}-${stamp()}.png`, 'image/png', b); else toast('Could not create the image', 'bad'); });
  }
  function exportModel() { download(`${baseName()}.truss.json`, 'application/json', JSON.stringify(serialize(state.model), null, 2)); toast('Model saved as JSON', 'ok'); }

  /* =====================================================================
   * 15. Misc UI: toast, help, bottom panel, file open, top bar
   * ===================================================================== */
  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast ${kind || ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function toggleHelp(show) { $('#helpModal').hidden = !show; }

  function setBottomTab(tab) {
    state.s.bottomTab = tab;
    $$('.tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    ['members', 'nodes', 'matrix', 'log'].forEach((t) => { $(`#tab-${t}`).hidden = t !== tab; });
    if (state.s.bottomCollapsed) setBottomCollapsed(false);
    renderTablesIfVisible();
    scheduleSave();
  }
  function setBottomCollapsed(c) {
    state.s.bottomCollapsed = c;
    $('#bottom').classList.toggle('collapsed', c);
    $('#btnCollapseBottom').innerHTML = c ? '&#9652;' : '&#9662;';
    $('#splitter').hidden = c;
    resizeCanvas();
    if (!c) renderTablesIfVisible();
    scheduleSave();
  }
  function bindBottom() {
    $$('.tabs .tab').forEach((b) => b.addEventListener('click', () => setBottomTab(b.dataset.tab)));
    $('#btnCollapseBottom').addEventListener('click', () => setBottomCollapsed(!state.s.bottomCollapsed));
    const sp = $('#splitter');
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId); sp.classList.add('active');
      const y0 = e.clientY, h0 = $('#bottom').offsetHeight;
      const move = (ev) => {
        const h = clamp(h0 - (ev.clientY - y0), 60, window.innerHeight - 260);
        state.s.bottomHeight = h;
        document.documentElement.style.setProperty('--bottom-h', `${h}px`);
        resizeCanvas();
      };
      const up = () => { sp.classList.remove('active'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); scheduleSave(); };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
    $$('#segMatrix button').forEach((b) => b.addEventListener('click', () => { state.s.mtxView = b.dataset.mtx; renderMatrix(); scheduleSave(); }));
    $$('#segMtxMode button').forEach((b) => b.addEventListener('click', () => { state.s.mtxMode = b.dataset.mode; renderMatrix(); scheduleSave(); }));
    $('#selMtxUnit').addEventListener('change', (e) => { state.s.mtxUnit = e.target.value; renderMatrix(); renderInspectorResults(); scheduleSave(); });
    $('#chkHideZeros').addEventListener('change', (e) => { state.s.mtxDimZeros = e.target.checked; renderMatrix(); scheduleSave(); });
  }
  function loadModel(model, msg) {
    state.model = model;
    state.activeGroup = model.groups[0] || null;
    state.editGroup = null;
    state.memberStart = null;
    state.mechMode = 0;
    clearSelection(false);
    renderLeftLists();
    renderInspector();
    fitView();
    solve(true);
    if (msg) toast(msg, 'ok');
  }
  function bindTopBar() {
    const sel = $('#selExample');
    EXAMPLES.forEach(([k, label]) => { const o = document.createElement('option'); o.value = k; o.textContent = label; sel.appendChild(o); });
    sel.addEventListener('change', () => {
      const k = sel.value;
      sel.value = '';
      if (!k) return;
      pushUndo();
      loadModel(buildExample(k), `Loaded example: ${EXAMPLES.find((e) => e[0] === k)[1]}`);
    });
    $('#btnNew').addEventListener('click', () => {
      if (state.model.nodes.length && !confirm('Start a new empty model? (You can undo this.)')) return;
      pushUndo();
      loadModel(emptyModel(), 'New model');
      state.view = { cx: 6, cy: 3, zoom: 50 };
      setTool('node');
    });
    $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const m = deserialize(JSON.parse(String(rd.result)));
          pushUndo();
          loadModel(m, `Opened “${f.name}”`);
        } catch (err) { toast(`Could not open ${f.name}: ${err.message}`, 'bad'); }
      };
      rd.readAsText(f);
    });
    $('#btnSave').addEventListener('click', exportModel);
    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);
    $('#btnSolve').addEventListener('click', () => solve(true));
    $('#chkLive').addEventListener('change', (e) => { state.s.liveSolve = e.target.checked; scheduleSave(); if (state.s.liveSolve) solve(false); else refreshResults(); });
    const menu = $('#exportMenu'), btn = $('#btnExport');
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    menu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
      menu.hidden = true;
      ({ 'report-csv': exportReportCSV, 'report-json': exportReportJSON, 'matrices-csv': exportMatricesCSV, 'matrices-json': exportMatricesJSON, png: exportPNG, model: exportModel })[b.dataset.export]();
    }));
    $('#btnHelp').addEventListener('click', () => toggleHelp(true));
    $('#btnCloseHelp').addEventListener('click', () => toggleHelp(false));
    $('#helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') toggleHelp(false); });
    $('#btnPanels').addEventListener('click', () => {
      const app = $('#app');
      if (window.innerWidth <= 920) app.classList.toggle('show-panels'); else app.classList.toggle('no-panels');
      setTimeout(resizeCanvas, 0);
    });
    $$('#tools .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#btnFit').addEventListener('click', fitView);
    $('#btnZoomIn').addEventListener('click', () => zoomAt(1.25, state.W / 2, state.H / 2));
    $('#btnZoomOut').addEventListener('click', () => zoomAt(0.8, state.W / 2, state.H / 2));
  }

  /* =====================================================================
   * 16. Start-up
   * ===================================================================== */
  function init() {
    const restored = loadSession();
    if (!restored) state.model = buildExample('pratt');
    state.activeGroup = state.model.groups[0] || null;
    bindTopBar();
    bindLeftPanel();
    bindBottom();
    document.documentElement.style.setProperty('--bottom-h', `${clamp(state.s.bottomHeight, 60, 900)}px`);
    syncSettingsUI();
    renderLeftLists();
    setTool('select');
    updateUndoButtons();
    new ResizeObserver(resizeCanvas).observe(viewport);
    resizeCanvas();
    setBottomTab(state.s.bottomTab);
    if (state.s.bottomCollapsed) setBottomCollapsed(true);
    if (!restored) fitView(); else updateZoomLabel();
    renderInspector();
    solve(true);
    refreshHint();
    if (restored) toast('Previous session restored. Use New or Examples to start over');
    window.addEventListener('blur', () => { state.spaceDown = false; });
  }
  init();

  // test hook for automated checks (no effect on the UI)
  window.TrussLab = { state, solve, buildExample, loadModel, serialize, deserialize, parseExpr, sectionProps };
})();
