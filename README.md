# TrussLab: 2D Truss FEA & Load Simulator

An interactive browser application for linear-elastic analysis of pin-jointed plane trusses by the Direct Stiffness Method. It runs entirely in the browser with no build step, no server and no external libraries.

## Running it

Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari). Double-clicking the file works (`file://`). You can also serve the folder:

```bash
python3 -m http.server 8000   # then browse to http://localhost:8000
```

| File | Purpose |
|------|---------|
| `index.html` | Page layout, panels and help dialog |
| `style.css` | Dark CAD-style theme |
| `fea-core.js` | Numerical engine (no DOM). Usable from Node: `require('./fea-core.js').analyze(input)` |
| `script.js` | Editor, canvas rendering, inspector, tables, matrix inspector and exports |

The session (model, view, settings) is autosaved to `localStorage`.

## Using it

- **Examples…** loads ready-made structures: Pratt, Howe and Warren trusses, an A-frame with a closed-form answer, a cantilever, a Fink roof truss in timber, an inclined roller, a support settlement, and an unstable mechanism.
- Tools: `V` select/move, `N` node, `M` member (chains; clicking empty space creates a node), `S` support, `L` load, `H` pan. Wheel zooms at the cursor. Middle or right drag pans.
- Snap grid: 0.1 / 0.25 / 0.5 / 1.0 / 2.0 m. Snapped coordinates are the doubles nearest to k·step (for example exactly `0.3`, not `0.30000000000000004`).
- Exact input: every numeric field accepts expressions, for example `2*sqrt(3)`, `12/7`, `10*cos(30)` (trig in degrees).
- Supports: pin, roller (u_y = 0), roller (u_x = 0), inclined roller at angle α, and custom supports with prescribed displacements in a rotated frame (settlements).
- Materials: Structural Steel (E 200 GPa, σy 250 MPa), 6061-T6 Aluminum (E 68.9 GPa, σy 276 MPa), Douglas Fir (E 11 GPa), or custom.
- Sections: section groups with custom A and I, or a calculator for solid round, CHS, solid rectangle and RHS/SHS. The calculator uses the weak-axis I.
- Load factor λ scales all nodal loads live. Deflection scale runs 1× to 1000× on the slider (typed values up to 10⁶), with an Auto mode.
- Bottom panel: member table, node and reaction table, stiffness matrix inspector ([K], rotated [K′], reduced [K_ff] with {F_eff} and {u_f}, element [kᵉ]; table or heatmap), and the solver log.
- Export: calculation report (CSV / JSON), system matrices (CSV / JSON), PNG image, and the model file (JSON; re-open with **Open…**).

## Conventions

- Axes: x to the right, y upward, angles counter-clockwise from +x in degrees.
- Loads and reactions are positive in +x / +y. Axial force, stress and strain are positive in tension.
- Calculations and exports use SI base units (m, N, Pa, m², m⁴). Input fields use GPa, MPa, mm², mm⁴. Force and displacement display units are selectable.

## Method

1. Element matrix in global axes: `[kᵉ] = (EA/L)[c² cs −c² −cs; cs s² −cs −s²; …]`, where `c = Δx/L`, `s = Δy/L` and `L = hypot(Δx, Δy)`. This avoids the trigonometric round-off of computing cos(atan2(…)).
2. Assembly of the 2n × 2n `[K]` with Neumaier-compensated summation. The result is exactly symmetric.
3. Inclined supports: exact rotation of the nodal frames, `K′ = Λ K Λᵀ`, `F′ = Λ F` (no penalty springs).
4. Partition: `K_ff u_f = F_f − K_fs u_s` (prescribed displacements included).
5. **Stability verification before solving**:
   - zero-stiffness DOFs are detected;
   - Jacobi equilibration `K̃ = D^-½ K_ff D^-½`;
   - rank-revealing (pivoted) Cholesky;
   - the determinant is computed in log form, so it cannot overflow;
   - the 1-norm condition number is exact up to 200 free DOFs and estimated with Hager/Higham above that;
   - the Maxwell count m + r − 2j is reported.

   Mechanisms are reported as rigid-body motion, a zero-stiffness joint, or an internal mechanism, and the mode shape is animated.
6. Solve: LU decomposition with partial pivoting, then iterative refinement whose residuals use error-free transformations (Dot2), at about twice double precision.
7. Results:
   - reactions `R = K u − F`;
   - member forces `F = (EA/L)[(u₂−u₁)c + (v₂−v₁)s]`;
   - stress `σ = F/A` and strain `ε = ΔL/L`;
   - Euler load `P_cr = π²EI/L²` with K = 1;
   - `SF = min(σy/|σ|, P_cr/|F|)`.

   Status is Safe, Yielded or Buckled.
8. Verification printed with every solve: global equilibrium (ΣFx, ΣFy, ΣM), nodal equilibrium rebuilt from the member forces, backward error, and the LU and Cholesky determinants compared with each other.

## Accuracy checks performed

These checks were run against `fea-core.js` during development:

| Case | Reference | Max. relative error |
|------|-----------|---------------------|
| 3-4-5 A-frame, P = 100 kN | F = −62.5 kN, u_y = −1.953125 mm (closed form) | 1.2e-16 |
| Symmetric 3-bar indeterminate truss | closed form | 3.1e-16 |
| Inclined roller at 30° | statics by hand | 3.4e-14 (cancellation in a small reaction) |
| Prescribed displacement of a bar | F = EAδ/L | 0 |
| Settlement of a determinate truss | all member forces zero | forces ≈ 1e-27 N, classified zero-force |
| Indeterminate X-braced truss with settlement (degree 2) | exact rational solution (Python `fractions`) | u 8e-17, F 6e-16, R 4e-15 |
| Square without diagonal, unsupported triangle, collinear joint | must be rejected as unstable | detected and classified correctly |
| 301-node Warren truss (599 free DOFs) | equilibrium | backward error 2.5e-17, solved in about 0.3 s |

## Assumptions and limitations

- Pin-jointed members carry axial force only. Loads act at nodes only. No self-weight, temperature, or geometric or material non-linearity.
- Linear (small-displacement) theory: equilibrium is written in the undeformed geometry.
- Euler buckling assumes ideal pin-ended members (K = 1) about the axis of the entered I. If σ_cr exceeds σy, yielding governs. Code resistance factors and inelastic buckling are not applied.
- Douglas Fir limit stress: timber has no yield point. The preset uses 49.9 MPa, the clear-wood compressive strength parallel to grain at 12 % moisture content ([USDA Wood Handbook](https://www.fpl.fs.usda.gov/documnts/fplgtr/fplgtr190/chapter_05.pdf), coast Douglas-fir). Graded lumber design values are much lower, so edit this for your grade and design code.
