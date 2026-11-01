/*!
 * fea-core.js - numerical engine of the 2D Truss FEA & Load Simulator.
 *
 * Linear-elastic, small-displacement analysis of pin-jointed plane trusses by the
 * Direct Stiffness Method. This file has no DOM access: it runs in browsers
 * (global `FEA`) and in Node.js (`require('./fea-core.js')`).
 *
 * Units: any consistent set. The UI passes SI base units (m, N, Pa, m^2, m^4).
 * Arithmetic: IEEE-754 binary64 (Float64Array) throughout. Assembly uses
 * Neumaier-compensated summation; residuals, reactions and member elongations use
 * error-free transformations (Dot2, Ogita-Rump-Oishi 2005) so they are evaluated
 * to roughly twice the working precision before the final rounding.
 *
 * Pipeline of analyze():
 *   1. validate input (geometry, properties, connectivity)
 *   2. element matrices k_e = (EA/L)[c^2 cs -c^2 -cs; ...] and global assembly of [K]
 *   3. rotation to nodal support frames for inclined supports: K' = L K L^T
 *   4. partition into free / restrained DOFs, effective load b = F_f - K_fs u_s
 *   5. stability verification BEFORE solving: zero-stiffness DOFs, Jacobi
 *      equilibration, rank-revealing (pivoted) Cholesky, determinant (log form),
 *      1-norm condition number; mechanisms are reported with their mode shapes
 *   6. LU decomposition with partial pivoting + iterative refinement
 *   7. reactions R = K u - F, member forces, stresses, strains, Euler buckling
 *   8. verification: global equilibrium, nodal equilibrium from member forces
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FEA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const EPS = Number.EPSILON;          // 2^-52
  const SPLITTER = 134217729;          // 2^27 + 1 (Veltkamp/Dekker splitting constant)
  const SQRT3_2 = Math.sqrt(3) / 2;
  const PI2 = Math.PI * Math.PI;
  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const DEFAULTS = Object.freeze({
    pivotTol: 1e-11,      // rank threshold on pivots of the unit-diagonal (equilibrated) matrix
    zeroDiagTol: 1e-13,   // diagonal stiffness below this fraction of the largest => zero-stiffness DOF
    zeroForceTol: 1e-9,   // |N| <= tol * F_ref => zero-force member
    coincideTol: 1e-9,    // relative to model size: coincident nodes / zero-length members
    condExactMax: 200,    // exact kappa_1 (explicit inverse) up to this many free DOFs, estimate above
    maxRefine: 6,         // max iterative refinement steps
    maxModes: 6,          // max mechanism modes reported
    targetSF: 1.5,        // members with SF below this are flagged
    illConditioned: 1e10, // kappa_1 of the equilibrated matrix above this => warning
  });

  /* ------------------------------------------------------------------ *
   *  Error-free transformations: double-word accumulator (Dot2 style)   *
   * ------------------------------------------------------------------ */
  let accHi = 0, accLo = 0;
  function accInit(v) { accHi = v; accLo = 0; }
  function accAdd(v) {                       // TwoSum (Knuth)
    const s = accHi + v, z = s - accHi;
    accLo += (accHi - (s - z)) + (v - z);
    accHi = s;
  }
  function accAddProd(a, b) {                // TwoProduct (Dekker) + TwoSum
    const p = a * b;
    let t = SPLITTER * a;
    const ah = t - (t - a), al = a - ah;
    t = SPLITTER * b;
    const bh = t - (t - b), bl = b - bh;
    const ep = al * bl - (((p - ah * bh) - al * bh) - ah * bl);
    const s = accHi + p, z = s - accHi;
    accLo += ((accHi - (s - z)) + (p - z)) + ep;
    accHi = s;
  }
  function accGet() { return accHi + accLo; }

  /** sum_i a[i]*b[i] evaluated with Dot2 (result as if computed in ~2x precision, then rounded). */
  function dot2(a, b) {
    accInit(0);
    for (let i = 0; i < a.length; i++) accAddProd(a[i], b[i]);
    return accGet();
  }
  /** Compensated sum of an array. */
  function sum2(a) {
    accInit(0);
    for (let i = 0; i < a.length; i++) accAdd(a[i]);
    return accGet();
  }

  /** cos and sin of an angle in degrees; exact for multiples of 30 and 45 degrees. */
  function cosSinDeg(deg) {
    if (!Number.isFinite(deg)) return [NaN, NaN];
    let a = deg % 360;
    if (a < 0) a += 360;
    const q = Math.floor(a / 90);
    const r = a - 90 * q;
    let c, s;
    if (r === 0) { c = 1; s = 0; }
    else if (r === 30) { c = SQRT3_2; s = 0.5; }
    else if (r === 45) { c = Math.SQRT1_2; s = Math.SQRT1_2; }
    else if (r === 60) { c = 0.5; s = SQRT3_2; }
    else { const t = r * Math.PI / 180; c = Math.cos(t); s = Math.sin(t); }
    switch (q) {
      case 0: return [c, s];
      case 1: return [-s, c];
      case 2: return [-c, -s];
      default: return [s, -c];
    }
  }

  /* ------------------------------------------------------------------ *
   *  Dense linear algebra (row-major Float64Array, n x n)               *
   * ------------------------------------------------------------------ */

  /**
   * In-place LU decomposition with partial (row) pivoting: P A = L U (Doolittle,
   * unit lower triangle). Zero entries are skipped, which keeps the cost close to
   * banded for typical truss matrices.
   */
  function luFactor(A, n) {
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    const nzCols = new Int32Array(n);
    let sign = 1, swaps = 0, logAbsDet = 0, minPiv = Infinity, maxPiv = 0, maxA = 0;
    for (let i = 0; i < n * n; i++) { const v = Math.abs(A[i]); if (v > maxA) maxA = v; }
    for (let k = 0; k < n; k++) {
      const kk = k * n;
      let p = k, big = Math.abs(A[kk + k]);
      for (let i = k + 1; i < n; i++) {
        const v = Math.abs(A[i * n + k]);
        if (v > big) { big = v; p = i; }
      }
      if (big === 0) {
        return { ok: false, zeroPivot: k, LU: A, perm, n, sign: 0, swaps, logAbsDet: -Infinity, minPiv: 0, maxPiv, growth: NaN };
      }
      if (p !== k) {
        const pp = p * n;
        for (let j = 0; j < n; j++) { const t = A[kk + j]; A[kk + j] = A[pp + j]; A[pp + j] = t; }
        const t = perm[k]; perm[k] = perm[p]; perm[p] = t;
        sign = -sign; swaps++;
      }
      const piv = A[kk + k];
      if (piv < 0) sign = -sign;
      const ap = Math.abs(piv);
      logAbsDet += Math.log10(ap);
      if (ap < minPiv) minPiv = ap;
      if (ap > maxPiv) maxPiv = ap;
      let nnz = 0;
      for (let j = k + 1; j < n; j++) if (A[kk + j] !== 0) nzCols[nnz++] = j;
      for (let i = k + 1; i < n; i++) {
        const ik = i * n, a = A[ik + k];
        if (a === 0) continue;
        const l = a / piv;
        A[ik + k] = l;
        for (let t = 0; t < nnz; t++) { const j = nzCols[t]; A[ik + j] -= l * A[kk + j]; }
      }
    }
    let maxU = 0;
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const v = Math.abs(A[i * n + j]); if (v > maxU) maxU = v; }
    return { ok: true, LU: A, perm, n, sign, swaps, logAbsDet, minPiv, maxPiv, growth: maxA > 0 ? maxU / maxA : 1 };
  }

  /** Solve A x = b from luFactor() output. `x` must not alias `b`. */
  function luSolve(F, b, x) {
    const LU = F.LU, perm = F.perm, n = F.n;
    if (!x) x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = b[perm[i]];
    for (let i = 1; i < n; i++) {
      const ii = i * n;
      let s = x[i];
      for (let j = 0; j < i; j++) { const l = LU[ii + j]; if (l !== 0) s -= l * x[j]; }
      x[i] = s;
    }
    for (let i = n - 1; i >= 0; i--) {
      const ii = i * n;
      let s = x[i];
      for (let j = i + 1; j < n; j++) { const u = LU[ii + j]; if (u !== 0) s -= u * x[j]; }
      x[i] = s / LU[ii + i];
    }
    return x;
  }

  /**
   * Rank-revealing Cholesky with diagonal pivoting for a symmetric positive
   * semi-definite matrix: P A P^T = L L^T (+ remainder below `tol`).
   * Works on a copy. Returns L (lower part of the work array), permutation,
   * pivots d_k (Schur-complement diagonals) and numerical rank.
   */
  function pivotedCholesky(Ain, n, tol) {
    const A = Float64Array.from(Ain);
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    const pivots = new Float64Array(n);
    const nz = new Int32Array(n);
    let rank = n;
    for (let k = 0; k < n; k++) {
      let q = k, dmax = A[k * n + k];
      for (let i = k + 1; i < n; i++) { const d = A[i * n + i]; if (d > dmax) { dmax = d; q = i; } }
      if (!(dmax > tol)) { rank = k; break; }
      if (q !== k) { // symmetric permutation: swap rows k,q then columns k,q
        const kk = k * n, qq = q * n;
        for (let j = 0; j < n; j++) { const t = A[kk + j]; A[kk + j] = A[qq + j]; A[qq + j] = t; }
        for (let i = 0; i < n; i++) { const ii = i * n; const t = A[ii + k]; A[ii + k] = A[ii + q]; A[ii + q] = t; }
        const t = perm[k]; perm[k] = perm[q]; perm[q] = t;
      }
      pivots[k] = dmax;
      const lkk = Math.sqrt(dmax);
      A[k * n + k] = lkk;
      let cnt = 0;
      for (let i = k + 1; i < n; i++) {
        const ik = i * n + k;
        if (A[ik] !== 0) { A[ik] /= lkk; nz[cnt++] = i; }
      }
      for (let a = 0; a < cnt; a++) { // trailing update of the full symmetric block
        const i = nz[a], ii = i * n, lik = A[ii + k];
        for (let b = 0; b < cnt; b++) { const j = nz[b]; A[ii + j] -= lik * A[j * n + k]; }
      }
    }
    let residual = 0;
    for (let i = rank; i < n; i++) residual = Math.max(residual, Math.abs(A[i * n + i]));
    return { L: A, perm, pivots, rank, n, residual };
  }

  /** Null-space basis from a rank-deficient pivoted Cholesky factorization. */
  function cholNullSpace(ch) {
    const L = ch.L, perm = ch.perm, r = ch.rank, n = ch.n;
    const basis = [];
    for (let t = r; t < n; t++) {
      const x = new Float64Array(n);
      x[t] = 1;
      for (let a = r - 1; a >= 0; a--) { // L11^T x1 = -L21^T e_t
        let s = -L[t * n + a];
        for (let b = a + 1; b < r; b++) s -= L[b * n + a] * x[b];
        x[a] = s / L[a * n + a];
      }
      const y = new Float64Array(n);
      for (let a = 0; a < n; a++) y[perm[a]] = x[a];
      basis.push(y);
    }
    return basis;
  }

  function norm1(A, n) {
    let best = 0;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.abs(A[i * n + j]);
      if (s > best) best = s;
    }
    return best;
  }
  function normInf(A, n) {
    let best = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const ii = i * n;
      for (let j = 0; j < n; j++) s += Math.abs(A[ii + j]);
      if (s > best) best = s;
    }
    return best;
  }
  function maxAbs(v) { let m = 0; for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (a > m) m = a; } return m; }

  /** Exact ||A^-1||_1 for the equilibrated matrix and ||K^-1||_1 = ||S A^-1 S||_1. */
  function invNorm1Exact(F, n, S) {
    const e = new Float64Array(n), x = new Float64Array(n);
    let scaled = 0, raw = 0;
    for (let j = 0; j < n; j++) {
      e.fill(0); e[j] = 1;
      luSolve(F, e, x);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) { const v = Math.abs(x[i]); s1 += v; s2 += S[i] * v; }
      if (s1 > scaled) scaled = s1;
      const rj = S[j] * s2;
      if (rj > raw) raw = rj;
    }
    return { scaled, raw };
  }

  /** Hager / Higham 1-norm estimator of ||A^-1||_1 for symmetric A (A^-T = A^-1). */
  function invNorm1Estimate(applyInv, n) {
    let x = new Float64Array(n).fill(1 / n);
    let est = 0, jPrev = -1;
    for (let it = 0; it < 5; it++) {
      const y = applyInv(x);
      let ny = 0;
      for (let i = 0; i < n; i++) ny += Math.abs(y[i]);
      if (it > 0 && ny <= est) break;
      est = ny;
      const xi = new Float64Array(n);
      for (let i = 0; i < n; i++) xi[i] = y[i] >= 0 ? 1 : -1;
      const z = applyInv(xi);
      let j = 0, zmax = -1, ztx = 0;
      for (let i = 0; i < n; i++) { const v = Math.abs(z[i]); if (v > zmax) { zmax = v; j = i; } ztx += z[i] * x[i]; }
      if (it > 0 && (zmax <= ztx || j === jPrev)) break;
      x = new Float64Array(n); x[j] = 1; jPrev = j;
    }
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = (i % 2 ? -1 : 1) * (1 + (n > 1 ? i / (n - 1) : 0));
    const w = applyInv(v);
    let nw = 0;
    for (let i = 0; i < n; i++) nw += Math.abs(w[i]);
    return Math.max(est, (2 * nw) / (3 * n));
  }

  /** log10 value -> { mantissa, exponent } without overflow. */
  function splitLog10(lg) {
    if (!Number.isFinite(lg)) return { mantissa: lg === -Infinity ? 0 : NaN, exponent: 0 };
    let e = Math.floor(lg), mnt = Math.pow(10, lg - e);
    if (mnt >= 9.9999999995) { mnt /= 10; e += 1; }
    return { mantissa: mnt, exponent: e };
  }

  function num(v, def) {
    if (v === undefined || v === null || v === '') return def === undefined ? NaN : def;
    return Number(v);
  }

  /* ------------------------------------------------------------------ *
   *  Main analysis                                                     *
   * ------------------------------------------------------------------ */

  /**
   * @param {object} input
   *   nodes:   [{ x, y, fx, fy, fixX, fixY, angle, dx, dy }]
   *            fixX / fixY restrain the axes x', y' of the nodal support frame, which is
   *            rotated `angle` degrees counter-clockwise from global x. dx / dy are
   *            prescribed displacements along x' / y' (used only when that axis is fixed).
   *   members: [{ i, j, E, A, I, fy }]  (0-based node indices; fy = yield / limit stress)
   *   options: overrides for DEFAULTS
   */
  function analyze(input) {
    const t0 = now();
    const opt = Object.assign({}, DEFAULTS, (input && input.options) || {});
    const nodesIn = (input && input.nodes) || [];
    const memsIn = (input && input.members) || [];
    const n = nodesIn.length, m = memsIn.length, ndof = 2 * n;

    const out = {
      version: VERSION, ok: false, stage: 'validation',
      errors: [], warnings: [], log: [],
      n, m, ndof, nf: 0, nodes: [], members: [],
      options: opt, diagnostics: {}, timing: 0,
    };
    const error = (msg, ref) => out.errors.push(ref ? { msg, ref } : { msg });
    const warn = (msg, ref) => out.warnings.push(ref ? { msg, ref } : { msg });
    const log = (msg) => out.log.push(msg);
    const nodeRef = (i) => ({ type: 'node', index: i });
    const memRef = (k) => ({ type: 'member', index: k });
    const finish = () => { out.timing = now() - t0; return out; };

    /* ---------- 1. Validation ---------- */
    if (n === 0) error('The model has no nodes.');
    if (m === 0) error('The model has no members. Add at least one member to run an analysis.');

    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    const nodes = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = nodesIn[i] || {};
      const nd = {
        x: num(s.x), y: num(s.y), fx: num(s.fx, 0), fy: num(s.fy, 0),
        fixX: !!s.fixX, fixY: !!s.fixY, angle: num(s.angle, 0),
        dx: s.fixX ? num(s.dx, 0) : 0, dy: s.fixY ? num(s.dy, 0) : 0,
      };
      if (!Number.isFinite(nd.x) || !Number.isFinite(nd.y)) error(`Node ${i + 1}: coordinates must be finite numbers.`, nodeRef(i));
      else { xmin = Math.min(xmin, nd.x); xmax = Math.max(xmax, nd.x); ymin = Math.min(ymin, nd.y); ymax = Math.max(ymax, nd.y); }
      if (!Number.isFinite(nd.fx) || !Number.isFinite(nd.fy)) error(`Node ${i + 1}: load components must be finite numbers.`, nodeRef(i));
      if (!Number.isFinite(nd.angle)) error(`Node ${i + 1}: support angle must be a finite number.`, nodeRef(i));
      if (!Number.isFinite(nd.dx) || !Number.isFinite(nd.dy)) error(`Node ${i + 1}: prescribed displacements must be finite numbers.`, nodeRef(i));
      nodes[i] = nd;
    }
    const extent = Math.max(xmax - xmin, ymax - ymin);
    const size = Number.isFinite(extent) && extent > 0 ? extent : 1;

    const degree = new Int32Array(n);
    const pairs = new Map();
    const elems = new Array(m);
    for (let k = 0; k < m; k++) {
      const s = memsIn[k] || {};
      const i = s.i, j = s.j;
      if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n) {
        error(`Member ${k + 1}: references a node that does not exist.`, memRef(k)); elems[k] = null; continue;
      }
      if (i === j) { error(`Member ${k + 1}: both ends are connected to node ${i + 1}.`, memRef(k)); elems[k] = null; continue; }
      const E = num(s.E), A = num(s.A), I = num(s.I), fy = num(s.fy);
      if (!(E > 0 && Number.isFinite(E))) error(`Member ${k + 1}: Young's modulus E must be a positive number.`, memRef(k));
      if (!(A > 0 && Number.isFinite(A))) error(`Member ${k + 1}: cross-sectional area A must be a positive number.`, memRef(k));
      if (!(I > 0 && Number.isFinite(I))) error(`Member ${k + 1}: second moment of area I must be a positive number.`, memRef(k));
      if (!(fy > 0 && Number.isFinite(fy))) error(`Member ${k + 1}: yield / limit stress must be a positive number.`, memRef(k));
      const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
      const L = Math.hypot(dx, dy);
      if (!(L > opt.coincideTol * size)) error(`Member ${k + 1}: zero length (nodes ${i + 1} and ${j + 1} coincide).`, memRef(k));
      const key = Math.min(i, j) * n + Math.max(i, j);
      if (pairs.has(key)) warn(`Members ${pairs.get(key) + 1} and ${k + 1} both connect nodes ${i + 1}-${j + 1}; they act in parallel.`, memRef(k));
      else pairs.set(key, k);
      degree[i]++; degree[j]++;
      elems[k] = { i, j, E, A, I, fy, dx, dy, L, c: dx / L, s: dy / L, k: E * A / L };
    }

    if (n <= 5000) { // coincident nodes (sweep on sorted x)
      const tol = opt.coincideTol * size;
      const order = [];
      for (let i = 0; i < n; i++) if (Number.isFinite(nodes[i].x) && Number.isFinite(nodes[i].y)) order.push(i);
      order.sort((a, b) => nodes[a].x - nodes[b].x);
      let reported = 0;
      for (let a = 0; a < order.length && reported < 10; a++) {
        for (let b = a + 1; b < order.length && nodes[order[b]].x - nodes[order[a]].x <= tol; b++) {
          if (Math.abs(nodes[order[b]].y - nodes[order[a]].y) <= tol) {
            const p = Math.min(order[a], order[b]) + 1, q = Math.max(order[a], order[b]) + 1;
            warn(`Nodes ${p} and ${q} occupy the same position; they are separate joints.`, nodeRef(q - 1));
            reported++;
          }
        }
      }
    }

    const active = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (degree[i] > 0) { active[i] = 1; continue; }
      if (nodes[i].fx !== 0 || nodes[i].fy !== 0) error(`Node ${i + 1} carries a load but no member is connected to it.`, nodeRef(i));
      else warn(`Node ${i + 1} is not connected to any member and was excluded from the analysis.`, nodeRef(i));
    }
    if (out.errors.length) return finish();

    let nAct = 0;
    for (let i = 0; i < n; i++) nAct += active[i];
    log(`Model: ${n} node(s) (${nAct} active), ${m} member(s), ${ndof} global DOFs (ux, uy per node).`);

    /* ---------- 2. Boundary conditions & support frames ---------- */
    const restrained = new Uint8Array(ndof);
    const presc = new Float64Array(ndof);
    const frame = new Float64Array(2 * n);
    const rotated = [];
    let nRestr = 0, nPresc = 0;
    for (let i = 0; i < n; i++) {
      frame[2 * i] = 1; frame[2 * i + 1] = 0;
      const nd = nodes[i];
      if (!active[i] || !(nd.fixX || nd.fixY)) continue;
      const cs = cosSinDeg(nd.angle);
      if (!(cs[0] === 1 && cs[1] === 0)) { frame[2 * i] = cs[0]; frame[2 * i + 1] = cs[1]; rotated.push(i); }
      if (nd.fixX) { restrained[2 * i] = 1; presc[2 * i] = nd.dx; nRestr++; if (nd.dx !== 0) nPresc++; }
      if (nd.fixY) { restrained[2 * i + 1] = 1; presc[2 * i + 1] = nd.dy; nRestr++; if (nd.dy !== 0) nPresc++; }
    }
    const isRot = new Uint8Array(n);
    for (const i of rotated) isRot[i] = 1;
    const dofLabels = new Array(ndof);
    for (let i = 0; i < n; i++) {
      const p = isRot[i] ? '\u2032' : '';
      dofLabels[2 * i] = `${i + 1}x${p}`;
      dofLabels[2 * i + 1] = `${i + 1}y${p}`;
    }
    out.dofLabels = dofLabels;

    const dg = m + nRestr - 2 * nAct;
    out.determinacy = { m, r: nRestr, j: nAct, degree: dg };
    log(`Maxwell count: m + r - 2j = ${m} + ${nRestr} - 2*${nAct} = ${dg} -> ` +
      (dg < 0 ? 'unstable (too few members or restraints).' : dg === 0 ? 'statically determinate if geometrically stable.' : `statically indeterminate to degree ${dg} if geometrically stable.`));

    /* ---------- 3. Element matrices and global assembly ---------- */
    const K = new Float64Array(ndof * ndof);
    const Kc = new Float64Array(ndof * ndof); // Neumaier compensation terms
    for (let k = 0; k < m; k++) {
      const e = elems[k];
      const kcc = e.k * (e.c * e.c), kss = e.k * (e.s * e.s), kcs = e.k * (e.c * e.s);
      const ke = new Float64Array([
        kcc, kcs, -kcc, -kcs,
        kcs, kss, -kcs, -kss,
        -kcc, -kcs, kcc, kcs,
        -kcs, -kss, kcs, kss,
      ]);
      const d = [2 * e.i, 2 * e.i + 1, 2 * e.j, 2 * e.j + 1];
      e.ke = ke; e.dofs = d;
      for (let a = 0; a < 4; a++) {
        const row = d[a] * ndof;
        for (let b = 0; b < 4; b++) {
          const v = ke[a * 4 + b];
          if (v === 0) continue;
          const idx = row + d[b], s0 = K[idx], t = s0 + v;
          Kc[idx] += Math.abs(s0) >= Math.abs(v) ? (s0 - t) + v : (v - t) + s0;
          K[idx] = t;
        }
      }
    }
    let nnz = 0;
    for (let idx = 0; idx < K.length; idx++) { K[idx] += Kc[idx]; if (K[idx] !== 0) nnz++; }
    let symmetric = true;
    for (let i = 0; i < ndof && symmetric; i++) for (let j = i + 1; j < ndof; j++) if (K[i * ndof + j] !== K[j * ndof + i]) { symmetric = false; break; }
    log(`Element matrices k_e = (EA/L)*[c^2 cs -c^2 -cs; ...] built for ${m} member(s) (c = dx/L, s = dy/L, L = hypot(dx, dy)).`);
    log(`Global stiffness [K] assembled: ${ndof}x${ndof}, ${nnz} non-zeros, compensated summation, ${symmetric ? 'exactly symmetric' : 'NOT symmetric'}.`);

    let Kt = K;
    if (rotated.length) { // K' = L K L^T for nodes with rotated support frames
      Kt = Float64Array.from(K);
      for (const i of rotated) {
        const c = frame[2 * i], s = frame[2 * i + 1], a = 2 * i, b = a + 1;
        for (let col = 0; col < ndof; col++) {
          const x = Kt[a * ndof + col], y = Kt[b * ndof + col];
          if (x === 0 && y === 0) continue;
          Kt[a * ndof + col] = c * x + s * y;
          Kt[b * ndof + col] = c * y - s * x;
        }
      }
      for (const i of rotated) {
        const c = frame[2 * i], s = frame[2 * i + 1], a = 2 * i, b = a + 1;
        for (let row = 0; row < ndof; row++) {
          const x = Kt[row * ndof + a], y = Kt[row * ndof + b];
          if (x === 0 && y === 0) continue;
          Kt[row * ndof + a] = c * x + s * y;
          Kt[row * ndof + b] = c * y - s * x;
        }
      }
      for (const i of rotated) for (const a of [2 * i, 2 * i + 1]) for (let col = 0; col < ndof; col++) {
        const v1 = Kt[a * ndof + col], v2 = Kt[col * ndof + a];
        if (v1 !== v2) { const av = 0.5 * (v1 + v2); Kt[a * ndof + col] = av; Kt[col * ndof + a] = av; }
      }
      log(`Inclined support frames at node(s) ${rotated.map((i) => i + 1).join(', ')}: K' = L K L^T, F' = L F (exact rotation, no penalty).`);
    }

    const F = new Float64Array(ndof);
    for (let i = 0; i < n; i++) if (active[i]) { F[2 * i] = nodes[i].fx; F[2 * i + 1] = nodes[i].fy; }
    const Ft = rotated.length ? Float64Array.from(F) : F;
    for (const i of rotated) {
      const c = frame[2 * i], s = frame[2 * i + 1], fx = F[2 * i], fy = F[2 * i + 1];
      Ft[2 * i] = c * fx + s * fy;
      Ft[2 * i + 1] = c * fy - s * fx;
    }

    /* ---------- 4. Partition ---------- */
    const freeArr = [], fixArr = [];
    for (let d = 0; d < ndof; d++) { if (!active[d >> 1]) continue; (restrained[d] ? fixArr : freeArr).push(d); }
    const nf = freeArr.length, ns = fixArr.length;
    const free = Int32Array.from(freeArr), fixed = Int32Array.from(fixArr);
    Object.assign(out, { K, Kt, F, Ft, free, fixed, nf, rotated, frame, active, restrained, prescribed: presc });
    log(`Boundary conditions: ${ns} restrained DOF(s)${nPresc ? ` (${nPresc} with non-zero prescribed displacement)` : ''}, ${nf} free DOF(s).`);

    const Kff = new Float64Array(nf * nf);
    for (let a = 0; a < nf; a++) { const row = free[a] * ndof; for (let b = 0; b < nf; b++) Kff[a * nf + b] = Kt[row + free[b]]; }
    const bf = new Float64Array(nf);
    for (let a = 0; a < nf; a++) {
      const row = free[a] * ndof;
      accInit(Ft[free[a]]);
      for (let b = 0; b < ns; b++) { const d = fixed[b], kv = Kt[row + d]; if (kv !== 0 && presc[d] !== 0) accAddProd(-kv, presc[d]); }
      bf[a] = accGet();
    }
    out.Kff = Kff; out.bf = bf;

    /* ---------- 5. Stability verification (before solving) ---------- */
    out.stage = 'stability';
    const D = out.diagnostics;
    D.nf = nf; D.ns = ns;
    const xf = new Float64Array(nf);
    let Sv = new Float64Array(nf);

    if (nf > 0) {
      let dmax = 0;
      for (let a = 0; a < nf; a++) dmax = Math.max(dmax, Kff[a * nf + a]);
      const zeroDofs = [], pos = [];
      for (let a = 0; a < nf; a++) (Kff[a * nf + a] > opt.zeroDiagTol * dmax ? pos : zeroDofs).push(a);
      for (const a of pos) Sv[a] = 1 / Math.sqrt(Kff[a * nf + a]);
      const np = pos.length;
      const As = new Float64Array(np * np); // Jacobi-equilibrated matrix D^-1/2 Kff D^-1/2
      for (let p = 0; p < np; p++) {
        const a = pos[p], ra = a * nf;
        for (let q = 0; q < np; q++) { const b = pos[q], v = Kff[ra + b]; As[p * np + q] = v === 0 ? 0 : (v * Sv[a]) * Sv[b]; }
      }
      const tol = Math.max(opt.pivotTol, 50 * np * EPS);
      const ch = pivotedCholesky(As, np, tol);
      const nullity = zeroDofs.length + (np - ch.rank);
      let minPiv = Infinity, maxPiv = 0, logDetChol = 0;
      for (let k = 0; k < ch.rank; k++) { const p = ch.pivots[k]; minPiv = Math.min(minPiv, p); maxPiv = Math.max(maxPiv, p); logDetChol += Math.log10(p); }
      D.rank = nf - nullity; D.nullity = nullity; D.minPivot = minPiv; D.maxPivot = maxPiv; D.pivotTol = tol;
      log(`Stability check: Jacobi-equilibrated K~ = D^-1/2 Kff D^-1/2 (unit diagonal); pivoted Cholesky rank ${nf - nullity}/${nf}` +
        (ch.rank ? `, smallest pivot ${minPiv.toExponential(3)} (threshold ${tol.toExponential(1)})` : '') +
        (zeroDofs.length ? `, ${zeroDofs.length} DOF(s) with zero stiffness` : '') + '.');

      if (nullity > 0) {
        /* ----- unstable: report mechanism modes ----- */
        const toGlobal = (ut) => {
          const ug = Float64Array.from(ut);
          for (const i of rotated) {
            const c = frame[2 * i], s = frame[2 * i + 1], a = ut[2 * i], b = ut[2 * i + 1];
            ug[2 * i] = c * a - s * b; ug[2 * i + 1] = s * a + c * b;
          }
          return ug;
        };
        const raw = [];
        for (const a of zeroDofs) { const v = new Float64Array(nf); v[a] = 1; raw.push({ v, dof: free[a] }); }
        if (ch.rank < np) {
          for (const y of cholNullSpace(ch)) {
            const v = new Float64Array(nf);
            for (let p = 0; p < np; p++) v[pos[p]] = y[p] * Sv[pos[p]];
            raw.push({ v, dof: -1 });
          }
        }
        const modes = [];
        for (const r of raw.slice(0, opt.maxModes)) {
          const ut = new Float64Array(ndof);
          for (let a = 0; a < nf; a++) ut[free[a]] = r.v[a];
          const ug = toGlobal(ut);
          let mx = 0;
          for (let i = 0; i < n; i++) mx = Math.max(mx, Math.hypot(ug[2 * i], ug[2 * i + 1]));
          if (mx > 0) for (let d = 0; d < ndof; d++) ug[d] /= mx;
          modes.push(describeMode(ug, r.dof, nodes, active, degree, dofLabels));
        }
        out.mechanism = { nullity, modes, zeroDofs: zeroDofs.map((a) => free[a]) };
        const first = modes[0];
        error(`Structure is kinematically unstable: stiffness matrix is singular (rank ${nf - nullity} of ${nf}, ${nullity} mechanism mode${nullity > 1 ? 's' : ''}). ${first ? first.description : ''}`);
        if (dg < 0) error(`Maxwell count m + r - 2j = ${dg} < 0: add ${-dg} member(s) or restraint(s) at least.`);
        D.detScaled = { log10: -Infinity, mantissa: 0, exponent: 0 };
        D.detRaw = { log10: -Infinity, mantissa: 0, exponent: 0, sign: 0 };
        log(`det(Kff) = 0 (numerically singular). Solution aborted; mechanism mode shapes returned.`);
        return finish();
      }

      /* ----- stable: LU with partial pivoting on the equilibrated matrix ----- */
      const Fct = luFactor(Float64Array.from(As), nf); // pos covers all DOFs here (np === nf)
      if (!Fct.ok) {
        error('LU factorization met an exactly zero pivot column; the structure is unstable.');
        return finish();
      }
      let sumLogDiag = 0;
      for (let a = 0; a < nf; a++) sumLogDiag += Math.log10(Kff[a * nf + a]);
      const logDetScaled = Fct.logAbsDet;
      const logDetRaw = logDetScaled + sumLogDiag;
      D.detScaled = Object.assign({ log10: logDetScaled, sign: Fct.sign }, splitLog10(logDetScaled));
      D.detRaw = Object.assign({ log10: logDetRaw, sign: Fct.sign }, splitLog10(logDetRaw));
      D.detCholLog10 = logDetChol;
      D.detAgreement = Math.abs(Math.pow(10, logDetScaled - logDetChol) - 1);
      D.luGrowth = Fct.growth; D.luSwaps = Fct.swaps;
      if (Fct.sign < 0) warn('Determinant of the reduced stiffness matrix is negative: matrix is not positive definite.');

      const normAs = norm1(As, nf), normKff = norm1(Kff, nf);
      let inv;
      if (nf <= opt.condExactMax) { inv = invNorm1Exact(Fct, nf, Sv); D.condMethod = 'exact'; }
      else {
        const tmpA = new Float64Array(nf), tmpB = new Float64Array(nf);
        const applyScaled = (v) => luSolve(Fct, v, new Float64Array(nf));
        const applyRaw = (v) => { for (let a = 0; a < nf; a++) tmpA[a] = v[a] * Sv[a]; luSolve(Fct, tmpA, tmpB); const r = new Float64Array(nf); for (let a = 0; a < nf; a++) r[a] = tmpB[a] * Sv[a]; return r; };
        inv = { scaled: invNorm1Estimate(applyScaled, nf), raw: invNorm1Estimate(applyRaw, nf) };
        D.condMethod = 'estimate';
      }
      D.cond1Scaled = normAs * inv.scaled;
      D.cond1Raw = normKff * inv.raw;
      D.digits = Math.max(0, -Math.log10(D.cond1Scaled * EPS));
      const dS = splitLog10(logDetScaled), dR = splitLog10(logDetRaw);
      log(`Determinant verification: det(Kff) = ${dR.mantissa.toFixed(6)}e${dR.exponent}, det(K~) = ${dS.mantissa.toFixed(6)}e${dS.exponent} ` +
        `(LU and Cholesky agree to ${D.detAgreement.toExponential(1)}); positive definite: ${Fct.sign > 0 ? 'yes' : 'NO'}.`);
      log(`Condition number (${D.condMethod}): kappa1(K~) = ${D.cond1Scaled.toExponential(3)}, kappa1(Kff) = ${D.cond1Raw.toExponential(3)} -> about ${Math.floor(D.digits)} significant digits are reliable before refinement.`);
      if (D.cond1Scaled > opt.illConditioned) warn(`The stiffness matrix is ill-conditioned (kappa1 = ${D.cond1Scaled.toExponential(2)}): the structure is close to a mechanism.`);

      /* ----- 6. Solve with iterative refinement (Dot2 residuals) ----- */
      out.stage = 'solve';
      const tmp = new Float64Array(nf), y = new Float64Array(nf);
      const solveScaled = (rhs, dst) => {
        for (let a = 0; a < nf; a++) tmp[a] = rhs[a] * Sv[a];
        luSolve(Fct, tmp, y);
        for (let a = 0; a < nf; a++) dst[a] = y[a] * Sv[a];
        return dst;
      };
      solveScaled(bf, xf);
      const r = new Float64Array(nf), dx = new Float64Array(nf);
      const normKinf = normInf(Kff, nf), normB = maxAbs(bf);
      const hist = [], corr = [];
      let done = false, prevChange = Infinity, iters = 0;
      for (let it = 0; it <= opt.maxRefine; it++) {
        for (let a = 0; a < nf; a++) {
          const row = a * nf;
          accInit(bf[a]);
          for (let b = 0; b < nf; b++) { const kv = Kff[row + b]; if (kv !== 0) accAddProd(-kv, xf[b]); }
          r[a] = accGet();
        }
        const rn = maxAbs(r), xn = maxAbs(xf), den = normKinf * xn + normB;
        hist.push(den > 0 ? rn / den : 0);
        if (done || it === opt.maxRefine || rn === 0) break;
        solveScaled(r, dx);
        for (let a = 0; a < nf; a++) xf[a] += dx[a];
        iters++;
        const xn2 = maxAbs(xf), change = xn2 > 0 ? maxAbs(dx) / xn2 : 0;
        corr.push(change);
        if (change <= EPS || change > 0.5 * prevChange) done = true;
        prevChange = change;
      }
      D.refineIterations = iters;
      D.backwardErrorHistory = hist;
      D.correctionHistory = corr;
      D.backwardError = hist[hist.length - 1];
      log(`LU (partial pivoting, ${Fct.swaps} row swap(s), growth ${Fct.growth.toFixed(2)}) + ${iters} refinement step(s) with double-word residuals: ` +
        `backward error ${hist[0].toExponential(2)} -> ${D.backwardError.toExponential(2)}` + (corr.length ? `, last correction ${corr[corr.length - 1].toExponential(2)} relative.` : '.'));
    } else {
      D.rank = 0; D.nullity = 0; D.minPivot = NaN; D.cond1Scaled = 1; D.cond1Raw = 1; D.condMethod = 'none';
      D.detScaled = { log10: 0, mantissa: 1, exponent: 0, sign: 1 }; D.detRaw = { log10: 0, mantissa: 1, exponent: 0, sign: 1 };
      D.refineIterations = 0; D.backwardError = 0; D.backwardErrorHistory = []; D.correctionHistory = [];
      log('All DOFs are restrained: displacements are fully prescribed, no system to solve.');
    }
    out.stage = 'solved';

    /* ---------- 7. Post-processing ---------- */
    const ut = new Float64Array(ndof); // displacements in nodal support frames
    for (let a = 0; a < nf; a++) ut[free[a]] = xf[a];
    for (let b = 0; b < ns; b++) ut[fixed[b]] = presc[fixed[b]];
    const u = Float64Array.from(ut);    // global displacements u = L^T u'
    for (const i of rotated) {
      const c = frame[2 * i], s = frame[2 * i + 1], a = ut[2 * i], b = ut[2 * i + 1];
      u[2 * i] = c * a - s * b; u[2 * i + 1] = s * a + c * b;
    }

    // Reactions R = K u - F (global), double-word evaluation
    const Rraw = new Float64Array(ndof);
    for (let d = 0; d < ndof; d++) {
      if (!active[d >> 1]) continue;
      const row = d * ndof;
      accInit(-F[d]);
      for (let col = 0; col < ndof; col++) { const kv = K[row + col]; if (kv !== 0) accAddProd(kv, u[col]); }
      Rraw[d] = accGet();
    }
    const Rt = Float64Array.from(Rraw);  // in support frames
    for (const i of rotated) {
      const c = frame[2 * i], s = frame[2 * i + 1], rx = Rraw[2 * i], ry = Rraw[2 * i + 1];
      Rt[2 * i] = c * rx + s * ry; Rt[2 * i + 1] = c * ry - s * rx;
    }
    let freeResidual = 0;
    for (let a = 0; a < nf; a++) { freeResidual = Math.max(freeResidual, Math.abs(Rt[free[a]])); Rt[free[a]] = 0; }
    const R = Float64Array.from(Rt);     // reported reactions, global components
    for (const i of rotated) {
      const c = frame[2 * i], s = frame[2 * i + 1], a = Rt[2 * i], b = Rt[2 * i + 1];
      R[2 * i] = c * a - s * b; R[2 * i + 1] = s * a + c * b;
    }
    Object.assign(out, { u, ut, R, Rt });

    let umax = 0, kmax = 0, Fmax = 0, Rmax = 0;
    for (let i = 0; i < n; i++) umax = Math.max(umax, Math.hypot(u[2 * i], u[2 * i + 1]));
    for (let k = 0; k < m; k++) kmax = Math.max(kmax, elems[k].k);
    Fmax = maxAbs(F); Rmax = maxAbs(R);

    // Member forces F = (EA/L)[(u2-u1)c + (v2-v1)s]
    const mres = new Array(m);
    let Nmax = 0;
    for (let k = 0; k < m; k++) {
      const e = elems[k];
      const du = u[2 * e.j] - u[2 * e.i], dv = u[2 * e.j + 1] - u[2 * e.i + 1];
      accInit(0); accAddProd(du, e.c); accAddProd(dv, e.s);
      const elong = accGet();
      const N = e.k * elong;
      Nmax = Math.max(Nmax, Math.abs(N));
      mres[k] = { e, elong, N };
    }
    const Fref = Math.max(Fmax, Rmax, kmax * umax, Nmax * 1e-300);
    const zeroTol = opt.zeroForceTol * Fref;

    const sum = {
      maxDisp: { value: 0, node: -1 }, maxUx: { value: 0, node: -1 }, maxUy: { value: 0, node: -1 },
      maxTension: { value: 0, member: -1 }, maxCompression: { value: 0, member: -1 },
      peakStress: { value: 0, member: -1 },
      minSF: { value: Infinity, member: -1, governs: '' },
      counts: { safe: 0, yielded: 0, buckled: 0, zero: 0, low: 0, tension: 0, compression: 0 },
      bucklingRisk: [], failures: [], lowSF: [],
      span: Number.isFinite(extent) ? xmax - xmin : 0, size, Fref,
    };
    for (let i = 0; i < n; i++) {
      const ux = u[2 * i], uy = u[2 * i + 1], um = Math.hypot(ux, uy);
      out.nodes.push({
        ux, uy, u: um, rx: R[2 * i], ry: R[2 * i + 1], active: !!active[i],
        restrained: [!!restrained[2 * i], !!restrained[2 * i + 1]],
        frame: [frame[2 * i], frame[2 * i + 1]], rotated: !!isRot[i],
        rLocal: [Rt[2 * i], Rt[2 * i + 1]], uLocal: [ut[2 * i], ut[2 * i + 1]],
      });
      if (um > sum.maxDisp.value) sum.maxDisp = { value: um, node: i };
      if (Math.abs(ux) > Math.abs(sum.maxUx.value)) sum.maxUx = { value: ux, node: i };
      if (Math.abs(uy) > Math.abs(sum.maxUy.value)) sum.maxUy = { value: uy, node: i };
    }

    for (let k = 0; k < m; k++) {
      const { e, elong, N } = mres[k];
      const strain = elong / e.L;
      const stress = e.E * strain;                 // = N / A
      const Pcr = PI2 * e.E * e.I / (e.L * e.L);   // Euler, pin-ended (K = 1)
      const zero = Math.abs(N) <= zeroTol;
      const state = zero ? 'zero' : N > 0 ? 'tension' : 'compression';
      const sfYield = zero ? Infinity : e.fy / Math.abs(stress);
      const sfBuckling = state === 'compression' ? Pcr / -N : Infinity;
      const sf = Math.min(sfYield, sfBuckling);
      const governs = zero ? 'none' : sfBuckling < sfYield ? 'buckling' : 'yield';
      let status = 'safe';
      if (!zero && sf < 1) status = governs === 'buckling' ? 'buckled' : 'yielded';
      const low = status === 'safe' && !zero && sf < opt.targetSF;
      const rg = Math.sqrt(e.I / e.A);
      const r = {
        i: e.i, j: e.j, L: e.L, c: e.c, s: e.s, angle: Math.atan2(e.dy, e.dx) * 180 / Math.PI,
        E: e.E, A: e.A, I: e.I, fy: e.fy, k: e.k, ke: e.ke, dofs: e.dofs,
        elong, strain, force: N, stress, Pcr, sigmaCr: Pcr / e.A, squash: e.fy * e.A,
        slenderness: e.L / rg, radiusGyration: rg,
        eulerValid: Pcr / e.A <= e.fy,
        sfYield, sfBuckling, sf, governs, state, status, lowSF: low,
        utilization: zero ? 0 : 1 / sf,
      };
      mres[k].r = r;
      out.members.push(r);
      if (zero) sum.counts.zero++;
      else if (state === 'tension') sum.counts.tension++;
      else sum.counts.compression++;
      if (status === 'safe') sum.counts.safe++;
      else if (status === 'yielded') sum.counts.yielded++;
      else sum.counts.buckled++;
      if (low) { sum.counts.low++; sum.lowSF.push(k); }
      if (status !== 'safe') sum.failures.push(k);
      if (!zero && N > sum.maxTension.value) sum.maxTension = { value: N, member: k };
      if (!zero && N < sum.maxCompression.value) sum.maxCompression = { value: N, member: k };
      if (!zero && Math.abs(stress) > Math.abs(sum.peakStress.value)) sum.peakStress = { value: stress, member: k };
      if (sf < sum.minSF.value) sum.minSF = { value: sf, member: k, governs };
      if (state === 'compression' && sfBuckling < Math.max(opt.targetSF, 1)) sum.bucklingRisk.push({ member: k, sf: sfBuckling, ratio: -N / Pcr });
    }
    sum.bucklingRisk.sort((a, b) => a.sf - b.sf);
    sum.spanRatio = sum.maxDisp.value > 0 && sum.span > 0 ? sum.span / sum.maxDisp.value : Infinity;
    out.summary = sum;

    /* ---------- 8. Verification ---------- */
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) if (active[i]) { cx += nodes[i].x; cy += nodes[i].y; }
    cx /= nAct; cy /= nAct;
    let refFx = 0, refFy = 0, refM = 0;
    accInit(0); for (let i = 0; i < n; i++) if (active[i]) { accAdd(F[2 * i]); accAdd(R[2 * i]); refFx += Math.abs(F[2 * i]) + Math.abs(R[2 * i]); }
    const sumFx = accGet();
    accInit(0); for (let i = 0; i < n; i++) if (active[i]) { accAdd(F[2 * i + 1]); accAdd(R[2 * i + 1]); refFy += Math.abs(F[2 * i + 1]) + Math.abs(R[2 * i + 1]); }
    const sumFy = accGet();
    accInit(0);
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const x = nodes[i].x - cx, y = nodes[i].y - cy;
      const tx = F[2 * i] + R[2 * i], ty = F[2 * i + 1] + R[2 * i + 1];
      accAddProd(x, F[2 * i + 1]); accAddProd(x, R[2 * i + 1]);
      accAddProd(-y, F[2 * i]); accAddProd(-y, R[2 * i]);
      refM += Math.abs(x) * (Math.abs(F[2 * i + 1]) + Math.abs(R[2 * i + 1])) + Math.abs(y) * (Math.abs(F[2 * i]) + Math.abs(R[2 * i]));
      void tx; void ty;
    }
    const sumM = accGet();
    const refF = refFx + refFy;
    D.equilibrium = {
      sumFx, sumFy, sumM, about: [cx, cy],
      relF: refF > 0 ? Math.hypot(sumFx, sumFy) / refF : 0,
      relM: refM > 0 ? Math.abs(sumM) / refM : 0,
    };
    // Nodal equilibrium from member axial forces: sum_e N_e[-c,-s,c,s] - F - R = 0
    const q = new Float64Array(ndof);
    const qc = new Float64Array(ndof);
    const addq = (d, v) => { const s0 = q[d], t = s0 + v; qc[d] += Math.abs(s0) >= Math.abs(v) ? (s0 - t) + v : (v - t) + s0; q[d] = t; };
    for (let k = 0; k < m; k++) {
      const { e, N } = mres[k];
      addq(2 * e.i, -N * e.c); addq(2 * e.i + 1, -N * e.s); addq(2 * e.j, N * e.c); addq(2 * e.j + 1, N * e.s);
    }
    let nodalRes = 0;
    for (let d = 0; d < ndof; d++) { if (!active[d >> 1]) continue; nodalRes = Math.max(nodalRes, Math.abs((q[d] + qc[d]) - F[d] - R[d])); }
    D.nodalResidual = nodalRes;
    D.nodalResidualRel = Fref > 0 ? nodalRes / Fref : 0;
    D.freeResidual = freeResidual;
    D.freeResidualRel = Fref > 0 ? freeResidual / Fref : 0;
    D.Fref = Fref;
    log(`Reactions R = K u - F (double-word dot products). Global equilibrium: sum Fx = ${sumFx.toExponential(2)} N, sum Fy = ${sumFy.toExponential(2)} N, ` +
      `sum M = ${sumM.toExponential(2)} N*m (relative ${Math.max(D.equilibrium.relF, D.equilibrium.relM).toExponential(1)}).`);
    log(`Member forces N = (EA/L)[(u2-u1)c + (v2-v1)s]; nodal equilibrium from member forces: max residual ${nodalRes.toExponential(2)} N (relative ${D.nodalResidualRel.toExponential(1)}).`);
    log(`Members: ${sum.counts.tension} tension, ${sum.counts.compression} compression, ${sum.counts.zero} zero-force (|N| <= ${opt.zeroForceTol.toExponential(0)} * ${Fref.toExponential(2)} N); ` +
      `${sum.counts.yielded} yielded, ${sum.counts.buckled} buckled.`);

    out.ok = true;
    finish();
    log(`Analysis completed in ${out.timing.toFixed(2)} ms.`);
    return out;
  }

  /** Classify a mechanism mode: rigid-body motion of the whole structure or internal mechanism. */
  function describeMode(ug, trivialDof, nodes, active, degree, dofLabels) {
    const n = nodes.length;
    const involved = [];
    for (let i = 0; i < n; i++) if (active[i] && Math.hypot(ug[2 * i], ug[2 * i + 1]) > 1e-3) involved.push(i);
    let N = 0, cx = 0, cy = 0;
    for (let i = 0; i < n; i++) if (active[i]) { N++; cx += nodes[i].x; cy += nodes[i].y; }
    cx /= N; cy /= N;
    let sx = 0, sy = 0, st = 0, sr = 0, norm = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const x = nodes[i].x - cx, y = nodes[i].y - cy, ux = ug[2 * i], uy = ug[2 * i + 1];
      sx += ux; sy += uy; st += x * uy - y * ux; sr += x * x + y * y; norm += ux * ux + uy * uy;
    }
    const ax = sx / N, ay = sy / N, w = sr > 0 ? st / sr : 0;
    let res = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const x = nodes[i].x - cx, y = nodes[i].y - cy;
      res += (ug[2 * i] - (ax - w * y)) ** 2 + (ug[2 * i + 1] - (ay + w * x)) ** 2;
    }
    const rigid = norm > 0 && res <= 1e-8 * norm && involved.length > 1;
    const list = involved.slice(0, 12).map((i) => i + 1).join(', ') + (involved.length > 12 ? ', ...' : '');
    let description, kind;
    if (trivialDof >= 0) {
      const i = trivialDof >> 1, axis = dofLabels[trivialDof].replace(/^\d+/, '');
      kind = 'zero-stiffness';
      description = degree[i] === 1
        ? `Node ${i + 1} hangs on a single member and is free to move perpendicular to it (${axis} direction).`
        : `Node ${i + 1} has no stiffness in the ${axis} direction: all members meeting there are collinear.`;
    } else if (rigid) {
      kind = 'rigid';
      const rad = Math.sqrt(sr / N);
      if (Math.abs(w) * rad < 1e-6 * Math.hypot(ax, ay)) {
        description = `Rigid-body translation of the structure (direction ${(Math.atan2(ay, ax) * 180 / Math.PI).toFixed(1)} deg): the supports do not prevent it.`;
      } else {
        const px = cx - ay / w, py = cy + ax / w;
        description = `Rigid-body rotation about (${px.toFixed(3)}, ${py.toFixed(3)}) m: the supports are insufficient or their reactions are concurrent/parallel.`;
      }
    } else {
      kind = 'internal';
      description = `Internal mechanism involving node(s) ${list}: a panel or joint lacks bracing (add a diagonal or a restraint).`;
    }
    return { u: ug, kind, nodes: involved, description };
  }

  return {
    VERSION, DEFAULTS, analyze,
    linalg: { luFactor, luSolve, pivotedCholesky, cholNullSpace, norm1, normInf, invNorm1Exact, invNorm1Estimate },
    util: { dot2, sum2, cosSinDeg, splitLog10 },
  };
});
