/* ============================================================
   Milky Way — barred spiral, continuous gas, free orbit camera
   ============================================================ */
(() => {
  'use strict';

  const canvas = document.getElementById('space');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setClearColor(0x010207, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, .1, 6000);

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(20261120);
  const rand = (a, b) => a + (b - a) * rng();
  function gauss() {
    let u = 0, v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const R = 132;
  const ARMS = 6;
  // NASA/Spitzer structure: two major arms attached to the bar ends,
  // two minor gas-rich arms, Far-3kpc spur and the Orion Spur.
  const ARM_DEFS = [
    { name: 'Scutum-Centaurus', base: .62, pitch: 2.55, weight: .46, width: .33, type: 'major', rMin: 22, rMax: 132 },
    { name: 'Perseus',          base: 3.76, pitch: 2.55, weight: .46, width: .33, type: 'major', rMin: 22, rMax: 114 },
    { name: 'Norma',            base: 1.95, pitch: 2.15, weight: .045, width: .10, type: 'minor', rMin: 14, rMax: 110 },
    { name: 'Sagittarius',      base: 5.09, pitch: 2.15, weight: .045, width: .10, type: 'minor', rMin: 14, rMax: 96 },
    { name: 'Far-3kpc',         base: .20, pitch: 1.25, weight: .006, width: .055, type: 'spur', rMin: 16, rMax: 42 },
    { name: 'Orion Spur',       base: 2.85, pitch: 2.45, weight: .008, width: .06, type: 'spur', rMin: 55, rMax: 82 },
  ];

  // ------------------------------------------------------------
  // Point-star shader
  // ------------------------------------------------------------
  const vertexShader = `
    uniform float uPixelScale;
    uniform float uMaxSize;
    uniform float uSizeBoost;
    attribute float aSize;
    attribute float aAlpha;
    attribute float aPhase;
    attribute vec3 aColor;
    uniform float uFade;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vColor = aColor;
      float twinkle = .94 + .06 * sin(aPhase);
      vAlpha = aAlpha * twinkle;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = min(aSize * uSizeBoost * uPixelScale / max(1.0, -mv.z), uMaxSize);
      gl_Position = projectionMatrix * mv;
    }
  `;
  const fragmentShader = `
    uniform float uFade;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 p = gl_PointCoord - vec2(.5);
      float d = length(p);
      if (d > .5) discard;
      float halo = pow(max(0.0, 1.0 - d * 2.0), 2.6);
      float core = pow(max(0.0, 1.0 - d * 4.2), 4.0);
      float a = (halo * .72 + core * .28) * vAlpha;
      gl_FragColor = vec4(vColor, a * uFade);
    }
  `;

  function makeStars(positions, colors, sizes, alphas, phases, opts = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1));
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        uPixelScale: { value: innerHeight * .92 },
        uMaxSize: { value: opts.maxSize || 12 },
        uSizeBoost: { value: opts.sizeBoost || 1 },
        uFade: { value: 1 },
      },
      transparent: true, depthWrite: false, depthTest: false,
      blending: opts.blending || THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = opts.renderOrder || 0;
    points.frustumCulled = false;
    return points;
  }

  const galaxy = new THREE.Group();
  scene.add(galaxy);

  // ------------------------------------------------------------
  // Stellar populations
  // ------------------------------------------------------------
  const warm = [[1.00,.70,.38],[1.00,.80,.52],[.98,.88,.64],[.94,.62,.32]];
  const white = [[.96,.95,.91],[.82,.88,1.00],[.72,.82,1.00]];
  const blue = [[.55,.78,1.00],[.66,.88,1.00],[.45,.66,1.00]];
  const red = [[1.00,.42,.30],[1.00,.56,.36],[.96,.32,.28]];

  function pickArm() {
    let u = rng();
    for (const a of ARM_DEFS) {
      if (u < a.weight) return a;
      u -= a.weight;
    }
    return ARM_DEFS[0];
  }
  function armTheta(r, arm, branch) {
    let th = arm.base + arm.pitch * Math.log(r / 12) + gauss() * arm.width * (.55 + .60 * (r / R));
    if (branch) th += rand(-.55, .55);
    return th;
  }
  function armPoint(r, arm, branch = false) {
    const th = armTheta(r, arm, branch);
    const rr = r * (1 + gauss() * .016);
    return [Math.cos(th) * rr, Math.sin(th) * rr];
  }
  function armAllows(arm, r) {
    return r >= (arm.rMin || 0) && r <= (arm.rMax || 160);
  }
  // Exponential-ish disc: no hard circular rim.
  function discRadius() {
    const u = rng() * .965;
    return Math.min(155, 10 - 43 * Math.log(1 - u));
  }
  function starColor(r, armStar, cls, armType) {
    const outer = clamp(r / R, 0, 1);
    const roll = rng();
    if (cls === 'blue') return blue[(rng() * blue.length) | 0];
    if (cls === 'red') return red[(rng() * red.length) | 0];
    if (armStar && (armType === 'minor' || armType === 'spur') && outer > .18 && roll < .62) {
      return roll < .34 ? blue[(rng() * blue.length) | 0] : white[(rng() * white.length) | 0];
    }
    if (armStar && armType === 'major' && outer > .20 && roll < .52) {
      return roll < .30 ? blue[(rng() * blue.length) | 0] : white[(rng() * white.length) | 0];
    }
    if (armStar && outer > .20 && roll < .42) return white[(rng() * white.length) | 0];
    if (roll < .10) return blue[(rng() * blue.length) | 0];
    if (roll < .18) return red[(rng() * red.length) | 0];
    return warm[(rng() * warm.length) | 0];
  }

  const starPos = [], starCol = [], starSize = [], starAlpha = [], starPhase = [];
  const brightPos = [], brightCol = [], brightSize = [], brightAlpha = [], brightPhase = [];

  // Main arm population: 62% faint, 30% medium, 8% bright.
  const MAIN = 350000;
  for (let i = 0; i < MAIN; i++) {
    const r = discRadius();
    if (r > R) continue;
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [x, z] = armPoint(r, arm, rng() < .10);
    const thick = .8 + 3.0 * Math.exp(-r / 25) + .5 * (r / R);
    const y = gauss() * thick;
    starPos.push(x, y, z);
    const roll = rng();
    let lum, size, alpha, cls = '';
    if (roll < .006) { lum = 2.2 + rng() * 1.4; size = 1.55 + rng() * 1.15; alpha = .62 + rng() * .12; cls = rng() < .55 ? 'blue' : 'red'; }
    else if (roll < .042) { lum = 1.35 + rng() * .55; size = .68 + rng() * .55; alpha = .48 + rng() * .16; cls = rng() < .45 ? 'blue' : ''; }
    else if (roll < .18) { lum = .72 + rng() * .34; size = .36 + rng() * .34; alpha = .48 + rng() * .20; }
    else { lum = .26 + rng() * .32; size = .30 + rng() * .30; alpha = .20 + rng() * .20; }
    const c = starColor(r, true, cls, arm.type);
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(size);
    starAlpha.push(alpha);
    starPhase.push(rand(0, Math.PI * 2));
  }

  // Inter-arm field, dim and smooth, no uniform rim.
  const FIELD = 100000;
  for (let i = 0; i < FIELD; i++) {
    const r = discRadius();
    if (r > 155) continue;
    const th = rand(0, Math.PI * 2);
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    const y = gauss() * (1.0 + 2.4 * Math.exp(-r / 32));
    starPos.push(x, y, z);
    const c = rng() < .36 ? white[(rng() * white.length) | 0] : warm[(rng() * warm.length) | 0];
    const lum = .20 + rng() * .32;
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(.26 + rng() * .28);
    starAlpha.push(.28 + rng() * .20);
    starPhase.push(rand(0, Math.PI * 2));
  }

  // Bulge and a tilted, elongated bar.
  const CORE = 13000;
  for (let i = 0; i < CORE; i++) {
    const r = Math.pow(rng(), 1.7) * 15;
    const th = rand(0, Math.PI * 2);
    const x = Math.cos(th) * r, z = Math.sin(th) * r * .72;
    const y = gauss() * (1.4 + 3.0 * Math.exp(-r / 9));
    starPos.push(x, y, z);
    const c = rng() < .78 ? warm[(rng() * warm.length) | 0] : white[(rng() * white.length) | 0];
    const lum = .8 + rng() * .55;
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(.48 + rng() * .42 + (rng() < .02 ? .30 : 0));
    starAlpha.push(.30 + rng() * .20);
    starPhase.push(rand(0, Math.PI * 2));
  }

  // A real central bar: smooth Gaussian ellipsoid, no hard rectangular edge.
  const BAR = 26000, BAR_TILT = .72;
  for (let i = 0; i < BAR; i++) {
    const bx = gauss() * 21.5, bz = gauss() * 5.2;
    const ca = Math.cos(BAR_TILT), sa = Math.sin(BAR_TILT);
    const x = bx * ca - bz * sa, z = bx * sa + bz * ca;
    const y = gauss() * 1.15;
    starPos.push(x, y, z);
    const c = warm[(rng() * warm.length) | 0];
    const lum = .58 + rng() * .40;
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(.42 + rng() * .40);
    starAlpha.push(.28 + rng() * .20);
    starPhase.push(rand(0, Math.PI * 2));
  }

  // Sparse irregular outer envelope.
  for (let i = 0; i < 7000; i++) {
    const th = rand(0, Math.PI * 2);
    const env = 132 + 17 * Math.sin(th * 3 + .8) + 9 * Math.sin(th * 5 - 1.1);
    const r = 86 + Math.pow(rng(), .58) * Math.max(14, env - 86);
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    const y = gauss() * (3.0 + rng() * 3.5);
    starPos.push(x, y, z);
    const c = rng() < .5 ? white[(rng() * white.length) | 0] : warm[(rng() * warm.length) | 0];
    const lum = .18 + rng() * .26;
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(.24 + rng() * .22);
    starAlpha.push(.08 + rng() * .10);
    starPhase.push(rand(0, Math.PI * 2));
  }

  // Halo and a few bright supergiants.
  for (let i = 0; i < 6000; i++) {
    const r = 12 + Math.pow(rng(), .5) * 145;
    const th = rand(0, Math.PI * 2);
    starPos.push(Math.cos(th) * r, gauss() * (10 + 10 * rng()), Math.sin(th) * r);
    const c = white[(rng() * white.length) | 0];
    const lum = .16 + rng() * .22;
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(.20 + rng() * .20);
    starAlpha.push(.07 + rng() * .10);
    starPhase.push(rand(0, Math.PI * 2));
  }
  for (let i = 0; i < 1100; i++) {
    const r = 12 + (R - 12) * Math.pow(rng(), .78);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [x, z] = armPoint(r, arm, rng() < .12);
    const y = gauss() * (1.1 + 2.5 * Math.exp(-r / 26));
    starPos.push(x + gauss() * .7, y, z + gauss() * .7);
    const hot = rng() < .56;
    const c = hot ? white[(rng() * white.length) | 0] : (rng() < .4 ? red[(rng() * red.length) | 0] : warm[(rng() * warm.length) | 0]);
    const lum = .95 + rng() * .55;
    starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    starSize.push(1.05 + rng() * .85);
    starAlpha.push(.70 + rng() * .16);
    starPhase.push(rand(0, Math.PI * 2));
    if (rng() < .28) {
      brightPos.push(x, y, z);
      brightCol.push(c[0] * 1.4, c[1] * 1.4, c[2] * 1.4);
      brightSize.push(.9 + rng() * 1.4);
      brightAlpha.push(.62);
      brightPhase.push(rand(0, Math.PI * 2));
    }
  }

  // Star-forming knots integrated into the arms.
  for (let i = 0; i < 420; i++) {
    const r = 12 + (R - 12) * Math.pow(rng(), .62);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [cx, cz] = armPoint(r, arm, false);
    const count = 5 + (rng() * 11 | 0);
    for (let j = 0; j < count; j++) {
      const x = cx + gauss() * 1.4, z = cz + gauss() * 1.3, y = gauss() * 1.0;
      starPos.push(x, y, z);
      const c = rng() < .45 ? [.60,.86,1.0] : (rng() < .5 ? [1.0,.46,.62] : [1.0,.70,.42]);
      const lum = .65 + rng() * .40;
      starCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
      starSize.push(.6 + rng() * 1.2);
      starAlpha.push(.38 + rng() * .34);
      starPhase.push(rand(0, Math.PI * 2));
    }
  }

  const stars = makeStars(starPos, starCol, starSize, starAlpha, starPhase, { maxSize: 12, sizeBoost: 1, renderOrder: 2, blending: THREE.NormalBlending });
  galaxy.add(stars);
  const brightStars = makeStars(brightPos, brightCol, brightSize, brightAlpha, brightPhase, { maxSize: 26, sizeBoost: 1, renderOrder: 3 });
  galaxy.add(brightStars);

  // Blue-white young associations along the major and minor arms.
  const youngPos = [], youngCol = [], youngSize = [], youngAlpha = [], youngPhase = [];
  for (let i = 0; i < 12000; i++) {
    const r = 18 + Math.pow(rng(), .72) * (R - 18);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [x, z] = armPoint(r, arm, rng() < .18);
    const c = rng() < .62 ? blue[(rng() * blue.length) | 0] : white[(rng() * white.length) | 0];
    const lum = .42 + rng() * .58;
    youngPos.push(x + gauss() * .7, gauss() * (.7 + 2.0 * Math.exp(-r / 30)), z + gauss() * .7);
    youngCol.push(c[0] * lum, c[1] * lum, c[2] * lum);
    youngSize.push(.28 + rng() * .30);
    youngAlpha.push(.24 + rng() * .16);
    youngPhase.push(rand(0, Math.PI * 2));
  }
  const youngStars = makeStars(youngPos, youngCol, youngSize, youngAlpha, youngPhase, { maxSize: 12, sizeBoost: 1, renderOrder: 2, blending: THREE.NormalBlending });
  galaxy.add(youngStars);

  // ------------------------------------------------------------
  // Continuous gas field along the arms — one layer, no blocks.
  // ------------------------------------------------------------
  function casualHash(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }
  function cnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = casualHash(ix, iy), b = casualHash(ix + 1, iy), c = casualHash(ix, iy + 1), d = casualHash(ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }
  function cfbm(x, y) {
    let v = 0, a = .5, f = 1;
    for (let i = 0; i < 5; i++) { v += a * cnoise(x * f, y * f); f *= 2.03; a *= .5; }
    return v;
  }
  function cloudTexture(seed) {
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d'), im = ctx.createImageData(S, S), data = im.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const nx = x / S, ny = y / S;
      const wx = cfbm(nx * 2.5 + seed, ny * 2.5 + seed * 2);
      const wy = cfbm(nx * 2.5 + seed + 4, ny * 2.5 + seed + 9);
      let n = cfbm(nx * 4.2 + wx * 1.5 + seed, ny * 4.2 + wy * 1.5 + seed * 2);
      n = Math.pow(n, 1.25);
      const dx = nx - .5, dy = ny - .5, d = Math.sqrt(dx * dx + dy * dy);
      const edge = 1 - clamp((d - .27) / .23, 0, 1);
      const density = clamp((n - .39) / .39, 0, 1);
      const i = (y * S + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, density * 1.15) * edge * 255);
    }
    ctx.putImageData(im, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }
  const CLOUD_TEX = cloudTexture(4.7);

  const gasVert = `
    attribute float aSize;
    attribute vec3 aColor;
    attribute float aAlpha;
    uniform float uPixelScale;
    uniform float uMaxSize;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vColor = aColor; vAlpha = aAlpha;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = min(aSize * uPixelScale / max(1.0, -mv.z), uMaxSize);
      gl_Position = projectionMatrix * mv;
    }
  `;
  const gasFrag = `
    uniform sampler2D uMap;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      if (t.a < .01) discard;
      gl_FragColor = vec4(vColor, t.a * vAlpha);
    }
  `;
  function makeGas(positions, colors, sizes, alphas, maxSize, blending) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: gasVert, fragmentShader: gasFrag,
      uniforms: {
        uPixelScale: { value: innerHeight * .92 },
        uMaxSize: { value: maxSize },
        uMap: { value: CLOUD_TEX },
      },
      transparent: true, depthWrite: false, depthTest: false,
      blending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  const gp = [], gc = [], gs = [], ga = [];
  const gasCols = [0x2f7bff, 0x38d9ff, 0x2be6c8, 0x8a4dff, 0xb06cff, 0xff4f9f, 0xffa35c];
  for (let i = 0; i < 24000; i++) {
    const r = 12 + Math.pow(rng(), .62) * (R - 12);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [x, z] = armPoint(r, arm, rng() < .08);
    gp.push(x + gauss() * 1.7, gauss() * (1.0 + 2.0 * Math.exp(-r / 28)), z + gauss() * 1.7);
    const c = new THREE.Color(gasCols[(rng() * gasCols.length) | 0]).multiplyScalar(.70 + rng() * .38);
    gc.push(c.r, c.g, c.b);
    gs.push(.10 + Math.pow(rng(), 1.8) * .55);
    ga.push(.13 + rng() * .17);
  }
  // HII knots: brighter but still part of the same continuous gas layer.
  for (let i = 0; i < 280; i++) {
    const r = 14 + Math.pow(rng(), .58) * (R - 14);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [x, z] = armPoint(r, arm, false);
    gp.push(x + gauss() * 1.2, gauss() * 1.2, z + gauss() * 1.2);
    const c = new THREE.Color([0xff4f8f, 0x66d8ff, 0xffa35c, 0xa875ff][(rng() * 4) | 0]).multiplyScalar(.9 + rng() * .35);
    gc.push(c.r, c.g, c.b);
    gs.push(.9 + rng() * 2.0);
    ga.push(.07 + rng() * .10);
  }
  const gasField = makeGas(gp, gc, gs, ga, 6, THREE.AdditiveBlending);
  gasField.renderOrder = 2;
  gasField.visible = false;
  galaxy.add(gasField);

  // Pink HII regions: small, bright, clustered; not a separate block.
  const hiiPos = [], hiiCol = [], hiiSize = [], hiiAlpha = [], hiiPhase = [];
  for (let i = 0; i < 920; i++) {
    const r = 16 + Math.pow(rng(), .60) * (R - 16);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [cx, cz] = armPoint(r, arm, false);
    const count = 3 + (rng() * 4 | 0);
    for (let j = 0; j < count; j++) {
      const x = cx + gauss() * 1.5, z = cz + gauss() * 1.4, y = gauss() * 1.1;
      const c = rng() < .52 ? [1.0, .30, .55] : (rng() < .65 ? [.55, .82, 1.0] : [1.0, .62, .34]);
      hiiPos.push(x, y, z);
      hiiCol.push(c[0], c[1], c[2]);
      hiiSize.push(.85 + rng() * 1.1);
      hiiAlpha.push(.16 + rng() * .14);
      hiiPhase.push(rand(0, Math.PI * 2));
    }
  }
  const hiiField = makeStars(hiiPos, hiiCol, hiiSize, hiiAlpha, hiiPhase, { maxSize: 26, sizeBoost: 1, renderOrder: 4 });
  galaxy.add(hiiField);

  // A thin warm haze, not a cloud texture.
  const hazePos = [], hazeCol = [], hazeSize = [], hazeAlpha = [], hazePhase = [];
  for (let i = 0; i < 24000; i++) {
    const r = 12 + Math.pow(rng(), .65) * (R - 12);
    const arm = pickArm();
    if (!armAllows(arm, r)) continue;
    const [x, z] = armPoint(r, arm, rng() < .1);
    hazePos.push(x, gauss() * (2.0 + 2.0 * rng()), z);
    const c = rng() < .68 ? [1.0, .70, .38] : [.56, .74, 1.0];
    const dim = .10 + rng() * .12;
    hazeCol.push(c[0] * dim, c[1] * dim, c[2] * dim);
    hazeSize.push(2.4 + rng() * 5.2);
    hazeAlpha.push(.020 + rng() * .030);
    hazePhase.push(rand(0, Math.PI * 2));
  }
  const haze = makeStars(hazePos, hazeCol, hazeSize, hazeAlpha, hazePhase, { maxSize: 34, sizeBoost: 1, renderOrder: 1 });
  haze.visible = false;
  galaxy.add(haze);

  // ------------------------------------------------------------
  // Whole-disc nebula haze: a procedural, continuous fog layer.
  // It follows the two main arms, but also fills the disc diffusely.
  // ------------------------------------------------------------
  const nebulaMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: .95 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform float uOpacity;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = .5;
        for (int i = 0; i < 4; i++) {
          v += a * noise(p);
          p = p * 2.03 + vec2(11.7, 5.3);
          a *= .5;
        }
        return v;
      }

      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float r = length(q) * 160.0;
        float theta = atan(q.y, q.x);
        float radial = smoothstep(160.0, 95.0, r) * smoothstep(4.0, 22.0, r);
        float ph1 = theta - 2.55 * log(max(r, 10.0) / 12.0) - .62;
        float ph2 = theta - 2.15 * log(max(r, 10.0) / 12.0) - 1.95;
        float arm1 = pow(0.5 + 0.5 * cos(2.0 * ph1), 1.5);
        float arm2 = pow(0.5 + 0.5 * cos(2.0 * ph2), 1.8);
        float arm = smoothstep(.06, .88, max(arm1, arm2 * .55));
        float n = fbm(q * 2.4 + vec2(4.1, 9.2));
        float n2 = fbm(q * 7.0 + vec2(theta * .7, 2.4));
        float cloud = smoothstep(.24, .78, n);
        float a = (.006 + .24 * arm) * (.14 + .86 * cloud) * radial;
        a += .060 * pow(max(0.0, n2 - .55), 2.0) * arm * radial;
        float core = smoothstep(42.0, 8.0, r);
        vec3 col = mix(vec3(.20, .42, .78), vec3(.50, .48, .90), arm * .55);
        col = mix(col, vec3(.98, .62, .34), core * .70);
        col += vec3(.55, .25, .55) * pow(max(0.0, n2 - .52), 2.0) * .95;
        gl_FragColor = vec4(col, a * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const nebulaPlane = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), nebulaMat);
  nebulaPlane.rotation.x = -Math.PI / 2;
  nebulaPlane.position.y = -.7;
  nebulaPlane.renderOrder = 1.25;
  nebulaPlane.visible = false;
  galaxy.add(nebulaPlane);

  // Dark dust lanes along the inner edges of the major arms.
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: .90 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform float uOpacity;
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = .5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(7.1, 3.7); a *= .5; }
        return v;
      }
      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float r = length(q) * 160.0;
        float theta = atan(q.y, q.x);
        float radial = smoothstep(155.0, 90.0, r) * smoothstep(3.0, 20.0, r);
        float ph = theta - 2.55 * log(max(r, 10.0) / 12.0) - .62;
        float lane = pow(0.5 + 0.5 * cos(2.0 * ph + 1.10), 12.0);
        float phb = theta - 2.15 * log(max(r, 10.0) / 12.0) - 1.95;
        float laneB = pow(0.5 + 0.5 * cos(2.0 * phb + 1.2), 14.0);
        float n = fbm(q * 6.0 + vec2(3.2, 8.4));
        float a = (lane + laneB * .35) * (.060 + .135 * n) * radial;
        if (a < .004) discard;
        gl_FragColor = vec4(.055, .030, .020, a * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const dustPlane = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), dustMat);
  dustPlane.rotation.x = -Math.PI / 2;
  dustPlane.position.y = -1.05;
  dustPlane.renderOrder = 3.6;
  dustPlane.visible = false;
  galaxy.add(dustPlane);

  // ------------------------------------------------------------
  // Core and bar blooms
  // ------------------------------------------------------------
  function radialTexture(inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, inner);
    g.addColorStop(.22, inner.replace(/[\d.]+\)$/, '.42)'));
    g.addColorStop(.55, outer.replace(/[\d.]+\)$/, '.16)'));
    g.addColorStop(1, outer);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; return tex;
  }
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture('rgba(255,226,166,.85)', 'rgba(255,170,72,0)'),
    color: 0xffdf9e, transparent: true, opacity: .12,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  }));
  coreGlow.scale.set(30, 30, 1); coreGlow.position.y = 1; coreGlow.renderOrder = .5;
  galaxy.add(coreGlow);
  const barGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture('rgba(255,225,160,.7)', 'rgba(255,150,52,0)'),
    color: 0xffd08a, transparent: true, opacity: .30,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    rotation: .38,
  }));
  barGlow.scale.set(76, 18, 1); barGlow.position.y = .8; barGlow.renderOrder = .7;
  barGlow.visible = false; // central bar bloom removed
  galaxy.add(barGlow);
  const haloGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture('rgba(220,190,132,.20)', 'rgba(70,90,160,0)'),
    color: 0x93b6ff, transparent: true, opacity: .022,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  }));
  haloGlow.scale.set(300, 300, 1); haloGlow.renderOrder = .2; galaxy.add(haloGlow);

  // ------------------------------------------------------------
  // Background
  // ------------------------------------------------------------
  const bgPos = [], bgCol = [], bgSize = [], bgAlpha = [], bgPhase = [];
  for (let i = 0; i < 2000; i++) {
    const rr = 700 + rng() * 1000, th = rand(0, Math.PI * 2), ph = Math.acos(rand(-1, 1));
    bgPos.push(rr * Math.sin(ph) * Math.cos(th), rr * Math.cos(ph), rr * Math.sin(ph) * Math.sin(th));
    const c = rng() < .45 ? white[(rng() * white.length) | 0] : warm[(rng() * warm.length) | 0];
    const dim = .16 + rng() * .30;
    bgCol.push(c[0] * dim, c[1] * dim, c[2] * dim);
    bgSize.push(rand(.7, 2.0)); bgAlpha.push(.10 + rng() * .24); bgPhase.push(rand(0, Math.PI * 2));
  }
  const background = makeStars(bgPos, bgCol, bgSize, bgAlpha, bgPhase, { maxSize: 4, sizeBoost: 1, renderOrder: 0 });
  scene.add(background);
  // Local multi-scale star fields: when the camera leaves the far view and
  // enters an arm, these provide the nearby stars that a single 400k disk
  // layer cannot resolve. They follow the current focus and fade by distance.
  function localField(count, radius, height, smin, smax, amin, amax, seed) {
    const lr = mulberry32(seed);
    const p = [], c = [], sz = [], al = [], ph = [];
    for (let i = 0; i < count; i++) {
      const rr = radius * Math.sqrt(lr());
      const th = lr() * Math.PI * 2;
      p.push(Math.cos(th) * rr, (lr() * 2 - 1) * height * (0.25 + lr() * .75), Math.sin(th) * rr);
      const pool = lr() < .56 ? white : (lr() < .55 ? warm : blue);
      const cc = pool[(lr() * pool.length) | 0];
      const dim = .55 + lr() * .45;
      c.push(cc[0] * dim, cc[1] * dim, cc[2] * dim);
      sz.push(smin + lr() * (smax - smin));
      al.push(amin + lr() * (amax - amin));
      ph.push(lr() * Math.PI * 2);
    }
    return makeStars(p, c, sz, al, ph, { maxSize: 4.5, sizeBoost: 1, blending: THREE.NormalBlending, renderOrder: 1 });
  }
  const nearStars = localField(45000, 34, 9, 1.25, 2.9, .45, .82, 911);
  const midStars = localField(16000, 105, 26, .50, 1.35, .18, .42, 912);
  nearStars.renderOrder = 1; midStars.renderOrder = 1;
  scene.add(nearStars, midStars);

  // ------------------------------------------------------------
  // Free camera: orbit, pan, zoom without changing focus
  // ------------------------------------------------------------
  const state = {
    azimuth: -.35, elevation: 1.42, distance: 300, zoomT: 0,
    auto: true, dragging: false, panning: false, lastX: 0, lastY: 0,
    keys: Object.create(null), focus: new THREE.Vector3(0, 0, 0),
  };
  const target = {
    azimuth: state.azimuth, elevation: state.elevation, zoomT: 0,
    focus: new THREE.Vector3(0, 0, 0),
  };
  function smooth01(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function resetView() {
    target.azimuth = -.35; target.elevation = 1.42; target.zoomT = 0;
    state.focus.set(0, 0, 0); target.focus.set(0, 0, 0); state.auto = true;
  }
  function clampFocus() {
    const r = Math.hypot(target.focus.x, target.focus.z);
    if (r > 145) { target.focus.x = target.focus.x / r * 145; target.focus.z = target.focus.z / r * 145; }
    target.focus.y = clamp(target.focus.y, -75, 75);
  }

  const el = document.getElementById('space');

  // ------------------------------------------------------------
  // Real memory graph: /omni-memory/graph → bright cyan/gold stars
  // ------------------------------------------------------------
  const graphGroup = new THREE.Group();
  scene.add(graphGroup);
  let graphNodes = [];
  let graphLinks = [];
  let graphScreen = [];
  let graphSelected = null;
  let graphHover = null;
  let graphBaseStatus = '连接记忆库…';
  let graphLoadedScope = 'all';
  let graphPoints = null;
  let graphLines = null;
  const graphProject = new THREE.Vector3();

  function graphHash(seed) {
    let t = Math.imul(seed + 0x6d2b79f5, 2654435761);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Place a memory star on one of the two major arms. Nodes are ordered along
  // the arm so 300+ entities/notes stay separated instead of forming a ball.
  function layoutGraphNode(index, total) {
    const arm = ARM_DEFS[index % 2];
    const pair = Math.floor(index / 2);
    const pairs = Math.max(1, Math.ceil(total / 2));
    const u = (pair + .5) / pairs;
    const r = arm.rMin + 5 + u * Math.max(8, (arm.rMax - arm.rMin - 8));
    const jitter = (graphHash(index * 17 + 3) - .5) * .34;
    const th = arm.base + arm.pitch * Math.log(r / 12) + jitter;
    const y = (graphHash(index * 31 + 7) - .5) * 4.2;
    return new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
  }

  function disposeGraphGroup() {
    for (const child of [...graphGroup.children]) {
      graphGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }
    graphPoints = null; graphLines = null;
  }

  function buildGraph(nodes, links) {
    disposeGraphGroup();
    graphNodes = nodes.map((node, index) => ({ ...node, pos: layoutGraphNode(index, nodes.length) }));
    const nodeIds = new Set(graphNodes.map(n => n.id));
    graphLinks = links.filter(link => nodeIds.has(link.source) && nodeIds.has(link.target));

    const p = [], c = [], sz = [], al = [], ph = [];
    for (const node of graphNodes) {
      const note = node.kind === 'note';
      const col = note ? [.55, .88, 1.0] : [1.0, .74, .38];
      p.push(node.pos.x, node.pos.y, node.pos.z);
      c.push(col[0], col[1], col[2]);
      sz.push((note ? 3.0 : 2.8) + Math.min(1, Number(node.weight ?? .5)) * 2.6);
      al.push(.88);
      ph.push(graphHash(node.id.length + node.pos.x * 29) * Math.PI * 2);
    }
    if (p.length) {
      graphPoints = makeStars(p, c, sz, al, ph, {
        maxSize: 26, sizeBoost: 1, blending: THREE.AdditiveBlending, renderOrder: 6,
      });
      graphGroup.add(graphPoints);
    }

    const lp = [];
    const byId = new Map(graphNodes.map(n => [n.id, n]));
    for (const link of graphLinks) {
      const a = byId.get(link.source), b = byId.get(link.target);
      if (!a || !b) continue;
      lp.push(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z);
    }
    if (lp.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x89bce8, transparent: true, opacity: .10,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      });
      graphLines = new THREE.LineSegments(geo, mat);
      graphLines.renderOrder = 5; graphLines.frustumCulled = false;
      graphGroup.add(graphLines);
    }

    const memCount = document.getElementById('memCount');
    if (memCount) memCount.textContent = String(graphNodes.length);
    graphSelected = null; graphHover = null;
    graphBaseStatus = `已接入 ${graphNodes.length} 个真实记忆星点 · 点击发光星点查看内容`;
    setGraphStatus(graphBaseStatus);
  }

  function setGraphStatus(text) {
    const status = document.getElementById('graphStatus');
    if (status) status.textContent = text;
  }

  async function loadGraph(scope = 'all') {
    graphLoadedScope = scope;
    setGraphStatus('读取记忆星图…');
    try {
      const response = await fetch(`/omni-memory/graph?scope=${encodeURIComponent(scope)}`, {
        headers: { accept: 'application/json' }, cache: 'no-store',
      });
      if (!response.ok) throw new Error(`graph ${response.status}`);
      const body = await response.json();
      if (!body?.ok) throw new Error('graph unavailable');

      const select = document.getElementById('memScope');
      if (select) {
        const current = scope;
        select.replaceChildren(new Option('全部层级', 'all'));
        for (const layer of (body.scopes ?? [])) {
          if (!layer.key) continue;
          const label = layer.key === 'global' ? 'global' : String(layer.key).replace(/^proj:/, '').split('#')[0];
          select.append(new Option(`${label}（${(layer.facts ?? 0) + (layer.notes ?? 0)}）`, layer.key));
        }
        select.value = [...select.options].some(o => o.value === current) ? current : 'all';
      }
      buildGraph(body.nodes ?? [], body.links ?? []);
    } catch (err) {
      graphNodes = []; graphLinks = [];
      const memCount = document.getElementById('memCount');
      if (memCount) memCount.textContent = '0';
      setGraphStatus('未连接记忆服务 · 在项目目录运行 omni serve 后刷新');
    }
  }

  function graphNodeAt(clientX, clientY) {
    let best = null, bestDistance = 21;
    for (const entry of graphScreen) {
      const d = Math.hypot(entry.x - clientX, entry.y - clientY);
      if (d < bestDistance) { bestDistance = d; best = entry.node; }
    }
    return best;
  }

  function openMemory(node) {
    graphSelected = node;
    const card = document.getElementById('memoryCard');
    const kind = document.getElementById('memKind');
    const title = document.getElementById('memTitle');
    const meta = document.getElementById('memMeta');
    const body = document.getElementById('memBody');
    if (!card || !title || !meta || !body) return;
    const isNote = node.kind === 'note';
    if (kind) kind.textContent = isNote ? 'MEMORY NOTE / 笔记' : 'ENTITY / 实体';
    title.textContent = String(node.label ?? node.id);
    meta.textContent = `#${node.id} · ${node.scope ?? 'global'}${node.weight ? ` · weight ${Number(node.weight).toFixed(2)}` : ''}`;
    body.textContent = '读取中…';
    card.classList.add('is-open');

    const detailUrl = `/omni-memory/node?node=${encodeURIComponent(node.id)}${graphLoadedScope && graphLoadedScope !== 'all' ? `&scope=${encodeURIComponent(graphLoadedScope)}` : ''}`;
    fetch(detailUrl, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`node ${r.status}`)))
      .then(data => {
        if (!data?.ok) throw new Error('node unavailable');
        if (data.node?.kind === 'note') {
          body.textContent = String(data.node.text ?? '');
          meta.textContent = `#${node.id} · ${data.node.scope ?? 'global'} · importance ${Number(data.node.importance ?? .5).toFixed(2)}${data.node.source ? ` · ${data.node.source}` : ''}`;
        } else {
          body.replaceChildren();
          const facts = data.node?.facts ?? [];
          if (!facts.length) body.append('暂无关联事实');
          for (const fact of facts) {
            const span = document.createElement('span');
            span.className = 'fact';
            const s = document.createElement('b'); s.textContent = String(fact.subject ?? '');
            span.append(s, ` —${fact.relation ?? '→'}→ ${fact.object ?? ''}`);
            body.append(span);
          }
          meta.textContent = `#${node.id} · ${node.scope ?? 'global'} · ${facts.length} 条事实`;
        }
      })
      .catch(() => { body.textContent = '这条记忆详情读取失败。'; });
  }

  function updateGraphScreen(now) {
    if (!graphNodes.length) { graphScreen.length = 0; setRingVisible(false); return; }
    graphScreen.length = 0;
    for (const node of graphNodes) {
      const p = graphProject.copy(node.pos).project(camera);
      if (p.z < -1 || p.z > 1) continue;
      graphScreen.push({
        node,
        x: (p.x * .5 + .5) * innerWidth,
        y: (-p.y * .5 + .5) * innerHeight,
        z: p.z,
      });
    }
    const active = graphSelected || graphHover;
    const entry = active ? graphScreen.find(item => item.node === active) : null;
    // The ring is a DOM overlay, not a world-space sprite: 32 CSS pixels at
    // every zoom level, so entering the galaxy never turns it into a giant
    // pixelated donut.
    if (entry && entry.x >= 0 && entry.x <= innerWidth && entry.y >= 0 && entry.y <= innerHeight) {
      const ring = document.getElementById('memRing');
      if (ring) {
        ring.style.left = `${entry.x}px`;
        ring.style.top = `${entry.y}px`;
        ring.classList.add('is-visible');
      }
    } else {
      setRingVisible(false);
    }
  }

  function setRingVisible(visible) {
    const ring = document.getElementById('memRing');
    if (ring) ring.classList.toggle('is-visible', visible);
  }

  el.addEventListener('pointermove', event => {
    if (state.panning || state.dragging) { graphHover = null; return; }
    const node = graphNodeAt(event.clientX, event.clientY);
    if (node) {
      graphHover = node;
      el.style.cursor = 'pointer';
      setGraphStatus(`${node.kind === 'note' ? '笔记' : '实体'} · ${String(node.label ?? '').slice(0, 72)}`);
    } else {
      graphHover = null;
      el.style.cursor = 'grab';
      if (graphBaseStatus) setGraphStatus(graphBaseStatus);
    }
  });

  let graphPress = null;
  el.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    graphPress = { x: event.clientX, y: event.clientY };
  });
  el.addEventListener('pointerup', event => {
    if (event.button !== 0 || !graphPress) return;
    const moved = Math.hypot(event.clientX - graphPress.x, event.clientY - graphPress.y);
    graphPress = null;
    if (moved > 5) return;
    const node = graphNodeAt(event.clientX, event.clientY);
    if (node) openMemory(node);
  });

  document.getElementById('memClose')?.addEventListener('click', () => {
    document.getElementById('memoryCard')?.classList.remove('is-open');
    graphSelected = null;
  });
  document.getElementById('memScope')?.addEventListener('change', event => {
    loadGraph(event.target.value || 'all');
  });

  window.__memoryMap = { loadGraph, get nodes() { return graphNodes; }, get screen() { return graphScreen; }, openMemory };
  const initialScope = new URLSearchParams(location.search).get('scope') || 'all';
  loadGraph(initialScope);
  el.addEventListener('pointerdown', e => {
    if (e.button === 1) {
      e.preventDefault();
      state.dragging = true; state.lastX = e.clientX; state.lastY = e.clientY;
      state.auto = false; el.style.cursor = 'grabbing'; return;
    }
    if (e.button === 0 && e.shiftKey) {
      state.dragging = true; state.lastX = e.clientX; state.lastY = e.clientY;
      state.auto = false; el.style.cursor = 'grabbing'; return;
    }
    if (e.button === 0 || e.button === 2) {
      state.panning = true; state.lastX = e.clientX; state.lastY = e.clientY;
      state.auto = false; el.style.cursor = 'grabbing';
    }
  });
  addEventListener('pointermove', e => {
    if (state.panning) {
      const dx = e.clientX - state.lastX, dy = e.clientY - state.lastY;
      state.lastX = e.clientX; state.lastY = e.clientY;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).normalize();
      target.focus.addScaledVector(right, -dx * state.distance * .00115);
      target.focus.addScaledVector(up, dy * state.distance * .00115);
      clampFocus(); return;
    }
    if (!state.dragging) return;
    const dx = e.clientX - state.lastX, dy = e.clientY - state.lastY;
    state.lastX = e.clientX; state.lastY = e.clientY;
    target.azimuth -= dx * .004;
    target.elevation = clamp(target.elevation + dy * .003, -1.45, 1.45);
  });
  addEventListener('pointerup', () => {
    state.dragging = false; state.panning = false; el.style.cursor = 'grab';
  });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
  // Wheel is anchored at the cursor. For one notch, move the focus by exactly
  // the amount that keeps the screen-plane point under the mouse fixed while
  // the camera distance changes. Only zoom-in is anchored; zoom-out stays put.
  el.addEventListener('wheel', e => {
    e.preventDefault(); state.auto = false;
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    const oldZoom = target.zoomT;
    const nextZoom = clamp(oldZoom - dy * .00135, 0, 1);
    if (dy < 0) {
      const rect = el.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const oldDist = 300 * Math.pow(7.2 / 300, smooth01(0, 1, oldZoom));
      const nextDist = 300 * Math.pow(7.2 / 300, smooth01(0, 1, nextZoom));
      const halfH = oldDist * Math.tan(THREE.MathUtils.degToRad(23));
      const halfW = halfH * (rect.width / rect.height);
      const ce = Math.cos(state.elevation), se = Math.sin(state.elevation);
      const fwd = new THREE.Vector3(-ce * Math.sin(state.azimuth), -se, -ce * Math.cos(state.azimuth));
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      const offset = new THREE.Vector3()
        .addScaledVector(right, nx * halfW)
        .addScaledVector(up, ny * halfH);
      target.focus.addScaledVector(offset, 1 - nextDist / oldDist);
      clampFocus();
    }
    target.zoomT = nextZoom;
  }, { passive: false });
  addEventListener('keydown', e => {
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) { e.preventDefault(); state.auto = false; }
    state.keys[e.code] = true;
    if (e.code === 'KeyR') resetView();
    if (e.code === 'KeyF') state.auto = !state.auto;
    if (e.code === 'KeyH') document.body.classList.toggle('hide-ui');
  });
  addEventListener('keyup', e => { state.keys[e.code] = false; });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    for (const obj of [stars, brightStars, youngStars, hiiField, haze, background, gasField, nearStars, midStars]) obj.material.uniforms.uPixelScale.value = innerHeight * .92;
  });

  let last = performance.now();
  let frameRaf = 0;
  let frameRunning = true;
  let parentVisible = true;
  const distEl = document.getElementById('dist');
  function frame(now) {
    frameRaf = 0;
    if (!frameRunning) return;
    const dt = Math.min(.05, Math.max(0, (now - last) / 1000 || 0));
    last = now;
    if (state.auto) target.azimuth += dt * .018;
    state.azimuth += (target.azimuth - state.azimuth) * Math.min(1, dt * 5);
    state.elevation += (target.elevation - state.elevation) * Math.min(1, dt * 5);
    state.zoomT += (target.zoomT - state.zoomT) * Math.min(1, dt * 4);
    state.focus.lerp(target.focus, Math.min(1, dt * 3));

    if (state.zoomT > .46) {
      // W/S use the camera's true 3D forward vector, including its vertical
      // component. The old code flattened dir.y to zero, which made the view
      // slide across the galactic plane instead of moving where the lens looks.
      const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
      if (dir.lengthSq() > .0001) dir.normalize();
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
      if (right.lengthSq() < .0001) right.set(1, 0, 0);
      right.normalize();
      const speed = 1.5 + 1.4 * smooth01(.5, 1, state.zoomT);
      if (state.keys.KeyW) target.focus.addScaledVector(dir, speed * dt);
      if (state.keys.KeyS) target.focus.addScaledVector(dir, -speed * dt);
      if (state.keys.KeyA) target.focus.addScaledVector(right, -speed * dt);
      if (state.keys.KeyD) target.focus.addScaledVector(right, speed * dt);
      clampFocus();
    }

    const focus = new THREE.Vector3().copy(state.focus);
    const distance = 300 * Math.pow(7.2 / 300, smooth01(0, 1, state.zoomT));
    const ce = Math.cos(state.elevation);
    camera.position.set(
      focus.x + distance * ce * Math.sin(state.azimuth),
      focus.y + distance * Math.sin(state.elevation),
      focus.z + distance * ce * Math.cos(state.azimuth)
    );
    camera.lookAt(focus);
    camera.updateMatrixWorld();
    updateGraphScreen(now);
    state.distance = distance;

    nearStars.position.copy(focus);
    midStars.position.copy(focus);
    const nearFade = smooth01(.46, .60, state.zoomT);
    const midFade = smooth01(.56, .74, state.zoomT);
    nearStars.material.uniforms.uFade.value = nearFade;
    midStars.material.uniforms.uFade.value = midFade;
    // At full-galaxy view these 61k local stars are fully transparent but
    // would still be submitted to the GPU; skip the draw entirely.
    nearStars.visible = nearFade > .015;
    midStars.visible = midFade > .015;
    const lodFade = 1 - .35 * smooth01(.45, .95, state.zoomT);
    stars.material.uniforms.uFade.value = lodFade;
    brightStars.material.uniforms.uFade.value = 1 - .20 * smooth01(.5, 1, state.zoomT);
    haze.material.uniforms.uFade.value = 1 - .65 * smooth01(.5, 1, state.zoomT);
    const coreFade = 1 - .80 * smooth01(.55, 1, state.zoomT);
    coreGlow.material.opacity = .10 * coreFade;
    barGlow.material.opacity = 0;

    if (distEl) distEl.textContent = Math.round(state.distance) + ' ly';
    renderer.render(scene, camera);
    if (frameRunning) frameRaf = requestAnimationFrame(frame);
  }

  function setRunning(next) {
    frameRunning = Boolean(next);
    if (!frameRunning) {
      if (frameRaf) cancelAnimationFrame(frameRaf);
      frameRaf = 0;
    } else if (!frameRaf) {
      frameRaf = requestAnimationFrame(frame);
    }
  }

  addEventListener('message', event => {
    if (!event.data || event.data.type !== 'omni:visible') return;
    parentVisible = Boolean(event.data.visible);
    setRunning(parentVisible && !document.hidden);
  });
  document.addEventListener('visibilitychange', () => {
    setRunning(parentVisible && !document.hidden);
  });

  camera.position.set(0, 294 * Math.sin(state.elevation), 294 * Math.cos(state.elevation));
  camera.lookAt(0, 0, 0);
  setRunning(parentVisible && !document.hidden);

  window.__dspGalaxy = { scene, camera, galaxy, stars, brightStars, youngStars, hiiField, haze, background, gasField, nebulaPlane, dustPlane, nearStars, midStars, R, ARMS, state, target, setRunning, get frameRunning() { return frameRunning; } };
})();

