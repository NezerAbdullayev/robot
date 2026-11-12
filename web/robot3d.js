// 3D robot: model, işıq, materiallar və hərəkət sistemi (three.js)
//
// Səhifə hər kadrda window.robotAudio = { level: 0..1, bands: [..] } verir (səs analizi).
// Xaricdən idarə: window.robot.gesture("wave" | "nod" | "shake" | "talk" | "glance")
//
// Kamera/yerləşmə URL ilə tənzimlənə bilər, məsələn:
//   /?cam=0,0.62,1.55&look=0,0.42,-0.25&fov=50

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// ---------------------------------------------------------------- tənzimləmələr
const q = new URLSearchParams(location.search);
const vec = (name, def) => (q.get(name) ? q.get(name).split(",").map(Number) : def);
const CFG = {
  fov: Number(q.get("fov") || 46),
  cam: vec("cam", [0, 0.6, 1.5]),
  look: vec("look", [0, 0.38, -0.2]),
  robotPos: vec("rpos", [0, 0, -0.3]),
  exposure: Number(q.get("exp") || 0.82),
  debug: q.has("debug"),
  fps: 30,
};

// ---------------------------------------------------------------- köməkçilər
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const rand = (a, b) => a + Math.random() * (b - a);
// Yumşaq "səs-küy": bir neçə sinusun cəmi (təbii, təkrarlanmayan hərəkət üçün)
const wobble = (t, s) =>
  Math.sin(t * 0.71 + s) * 0.5 + Math.sin(t * 1.37 + s * 1.9) * 0.3 + Math.sin(t * 2.93 + s * 3.1) * 0.2;

// Kritik sönümlü yay: hərəkətləri "servo" kimi yumşaq edir
class Spring {
  constructor(v = 0, k = 60, d = 2 * Math.sqrt(60)) { this.v = v; this.vel = 0; this.k = k; this.d = d; this.target = v; }
  step(dt) {
    const a = this.k * (this.target - this.v) - this.d * this.vel;
    this.vel += a * dt;
    this.v += this.vel * dt;
    return this.v;
  }
}

// ---------------------------------------------------------------- prosedur teksturalar
function canvasTex(size, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// İşlənmiş ağ boya: ləkələr, cızıqlar, toz
function paintColor(ctx, s) {
  ctx.fillStyle = "#d8d2c6";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) { // çirk ləkələri
    const x = Math.random() * s, y = Math.random() * s, r = rand(10, 70);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(90,80,65,${rand(0.04, 0.12)})`);
    g.addColorStop(1, "rgba(90,80,65,0)");
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 6000; i++) { // toz
    ctx.fillStyle = `rgba(60,55,45,${rand(0.02, 0.07)})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1);
  }
  for (let i = 0; i < 60; i++) { // cızıqlar
    const x = Math.random() * s, y = Math.random() * s, a = rand(0, TAU), l = rand(6, 40);
    ctx.strokeStyle = Math.random() < 0.5 ? `rgba(255,255,255,${rand(0.2, 0.5)})` : `rgba(70,65,60,${rand(0.15, 0.35)})`;
    ctx.lineWidth = rand(0.5, 1.4);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  for (let i = 0; i < 10; i++) { // boyası qopmuş yerlər
    const x = Math.random() * s, y = Math.random() * s;
    ctx.fillStyle = "rgba(120,118,112,.55)";
    ctx.beginPath(); ctx.ellipse(x, y, rand(1, 4), rand(1, 3), rand(0, TAU), 0, TAU); ctx.fill();
  }
}
function paintRough(ctx, s) {
  ctx.fillStyle = "rgb(150,150,150)";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 4000; i++) {
    const v = 120 + Math.random() * 70;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  }
  for (let i = 0; i < 80; i++) { // cızıqlar daha parlaq (az kələ-kötür)
    const x = Math.random() * s, y = Math.random() * s, a = rand(0, TAU), l = rand(6, 40);
    ctx.strokeStyle = "rgb(70,70,70)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
}
function metalRough(ctx, s) {
  for (let y = 0; y < s; y++) { // fırçalanmış metal xətləri
    const v = 90 + Math.random() * 60;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, y, s, 1);
  }
}
function glowTex(ctx, s) {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(190,225,255,.6)");
  g.addColorStop(0.5, "rgba(90,170,255,.18)");
  g.addColorStop(1, "rgba(60,140,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
}

// ---------------------------------------------------------------- materiallar
const MAT = {
  paint: new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: canvasTex(1024, paintColor),
    roughnessMap: canvasTex(1024, paintRough, false),
    roughness: 1.0, metalness: 0.05,
    clearcoat: 0.3, clearcoatRoughness: 0.45,
  }),
  darkMetal: new THREE.MeshStandardMaterial({ color: 0x3b3e43, metalness: 0.85, roughness: 0.55, roughnessMap: canvasTex(256, metalRough, false) }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 1.0, roughness: 0.3, roughnessMap: canvasTex(256, metalRough, false) }),
  black: new THREE.MeshStandardMaterial({ color: 0x0d0f12, metalness: 0.3, roughness: 0.6 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.0, roughness: 0.8 }),
  lens: new THREE.MeshPhysicalMaterial({ color: 0x9fcfff, emissive: 0x6db6ff, emissiveIntensity: 1.2, roughness: 0.08, metalness: 0, clearcoat: 1 }),
  pupil: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  rim: new THREE.MeshBasicMaterial({ color: 0x8fd0ff }),
  ledGreen: new THREE.MeshBasicMaterial({ color: 0x5dff8a }),
  ledAmber: new THREE.MeshBasicMaterial({ color: 0xffb347 }),
};
const GLOW_TEX = canvasTex(128, glowTex);

// ---------------------------------------------------------------- geometriya köməkçiləri
function mesh(geo, mat, parent, pos = [0, 0, 0], rot = [0, 0, 0]) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 4, r);
const cyl = (rt, rb, h, seg = 32) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sphere = (r) => new THREE.SphereGeometry(r, 32, 24);
const torus = (r, t) => new THREE.TorusGeometry(r, t, 12, 48);
const capsule = (r, l) => new THREE.CapsuleGeometry(r, l, 8, 24);

function screws(parent, pts, z, r = 0.0045) {
  for (const [x, y] of pts) {
    mesh(cyl(r, r, 0.003, 16), MAT.steel, parent, [x, y, z], [Math.PI / 2, 0, 0]);
    mesh(new THREE.BoxGeometry(r * 1.6, r * 0.35, 0.001), MAT.black, parent, [x, y, z + 0.0016], [0, 0, rand(0, Math.PI)]);
  }
}

function glow(parent, pos, scale, opacity = 0.6) {
  const m = new THREE.Sprite(new THREE.SpriteMaterial({
    map: GLOW_TEX, color: 0x7cc4ff, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  m.position.set(...pos);
  m.scale.set(scale[0], scale[1], 1);
  parent.add(m);
  return m;
}

// Kabel: iki nöqtə arasında sallanan boru
function cable(parent, a, b, mid, r = 0.0055) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const M = new THREE.Vector3(...mid);
  const curve = new THREE.CatmullRomCurve3([A, M, B]);
  return mesh(new THREE.TubeGeometry(curve, 20, r, 8), MAT.rubber, parent);
}

// ---------------------------------------------------------------- ağız (LED ekran)
const MOUTH_W = 0.21, MOUTH_TOP = 0.027, MOUTH_BOTTOM = -0.035;
function mouthShape() {
  const s = new THREE.Shape();
  const w = MOUTH_W / 2;
  s.moveTo(-w, MOUTH_TOP);
  s.lineTo(w, MOUTH_TOP);
  s.bezierCurveTo(w, MOUTH_TOP - 0.03, w * 0.66, MOUTH_BOTTOM, 0, MOUTH_BOTTOM);
  s.bezierCurveTo(-w * 0.66, MOUTH_BOTTOM, -w, MOUTH_TOP - 0.03, -w, MOUTH_TOP);
  return s;
}
function fitUV(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox, pos = geo.attributes.position, uv = [];
  for (let i = 0; i < pos.count; i++) {
    uv.push((pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
  }
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

class MouthLED {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 320; this.canvas.height = 112;
    this.ctx = this.canvas.getContext("2d");
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.levels = new Array(17).fill(0);
    // Barmaqlıq dəlikləri (bir dəfə çəkilir)
    this.mesh = document.createElement("canvas");
    this.mesh.width = 320; this.mesh.height = 112;
    const m = this.mesh.getContext("2d");
    m.fillStyle = "rgba(0,0,0,.62)";
    m.fillRect(0, 0, 320, 112);
    m.globalCompositeOperation = "destination-out";
    for (let y = 2; y < 112; y += 5) for (let x = (y % 10 ? 2.5 : 0); x < 320; x += 5) {
      m.beginPath(); m.arc(x, y, 1.7, 0, TAU); m.fill();
    }
  }
  draw(bands, idle) {
    const c = this.ctx, W = 320, H = 112, N = this.levels.length;
    c.fillStyle = "#0a1119"; c.fillRect(0, 0, W, H);
    const step = W / N;
    for (let i = 0; i < N; i++) {
      const center = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
      const v = Math.max(idle * (1 - center * 0.5), bands[i] || 0);
      this.levels[i] += (v - this.levels[i]) * (v > this.levels[i] ? 0.7 : 0.3);
      const h = 6 + this.levels[i] * (H - 14);
      const x = i * step + step * 0.2, w = step * 0.6, y = (H - h) / 2 + 6;
      const g = c.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "#6fb8ff"); g.addColorStop(0.5, "#eaf6ff"); g.addColorStop(1, "#6fb8ff");
      c.globalAlpha = 0.35 + this.levels[i] * 0.65;
      c.shadowColor = "#5fb0ff"; c.shadowBlur = 10;
      c.fillStyle = g;
      c.beginPath(); c.roundRect(x, y, w, h, 3); c.fill();
    }
    c.globalAlpha = 1; c.shadowBlur = 0;
    c.drawImage(this.mesh, 0, 0);
    this.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- əl
class Hand {
  constructor(side) {
    this.side = side; // -1 sol, +1 sağ
    this.group = new THREE.Group();
    this.curl = 0.35;
    const palm = mesh(rbox(0.07, 0.024, 0.075, 0.008), MAT.paint, this.group, [0, 0, 0.03]);
    mesh(cyl(0.022, 0.022, 0.03, 24), MAT.darkMetal, this.group, [0, 0, -0.012], [Math.PI / 2, 0, 0]); // bilək
    this.fingers = [];
    for (let i = 0; i < 4; i++) {
      const base = new THREE.Group();
      base.position.set((i - 1.5) * 0.017, -0.002, 0.068);
      this.group.add(base);
      const segs = [];
      let parent = base;
      for (let j = 0; j < 3; j++) {
        const len = [0.026, 0.02, 0.016][j] * (i === 3 ? 0.85 : 1);
        const joint = new THREE.Group();
        parent.add(joint);
        mesh(sphere(0.0075), MAT.darkMetal, joint);
        mesh(capsule(0.0068, len - 0.012), j === 2 ? MAT.paint : MAT.steel, joint, [0, 0, len / 2], [Math.PI / 2, 0, 0]);
        const next = new THREE.Group(); next.position.z = len; joint.add(next);
        segs.push(joint); parent = next;
      }
      this.fingers.push(segs);
    }
    // baş barmaq
    const tb = new THREE.Group();
    tb.position.set(-side * 0.038, -0.002, 0.03);
    tb.rotation.set(0, -side * 0.9, 0);
    this.group.add(tb);
    mesh(sphere(0.008), MAT.darkMetal, tb);
    mesh(capsule(0.0075, 0.02), MAT.steel, tb, [0, 0, 0.016], [Math.PI / 2, 0, 0]);
    this.thumb = tb;
  }
  update(t, curl) {
    this.curl += (curl - this.curl) * 0.15;
    this.fingers.forEach((segs, i) => {
      segs.forEach((joint, j) => {
        joint.rotation.x = this.curl * [0.9, 1.1, 0.8][j] + Math.sin(t * 0.9 + i) * 0.03;
      });
    });
    this.thumb.rotation.x = this.curl * 0.6;
  }
}

// ---------------------------------------------------------------- robot modeli
class Robot {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.position.set(...CFG.robotPos);
    scene.add(this.root);

    // Bel (masanın altında qalan hissə də var)
    this.waist = new THREE.Group();
    this.root.add(this.waist);
    mesh(cyl(0.085, 0.1, 0.12), MAT.darkMetal, this.waist, [0, -0.02, 0]);
    for (let i = 0; i < 3; i++) mesh(torus(0.09, 0.006), MAT.steel, this.waist, [0, -0.05 + i * 0.03, 0], [Math.PI / 2, 0, 0]);
    
    // Gövdə
    this.torso = new THREE.Group();
    this.torso.position.set(0, 0.06, 0);
    this.waist.add(this.torso);
    const T = this.torso;
    mesh(rbox(0.27, 0.25, 0.18, 0.05), MAT.paint, T, [0, 0.14, 0]);
    mesh(rbox(0.2, 0.15, 0.02, 0.012), MAT.paint, T, [0, 0.15, 0.089]); // döş paneli
    mesh(rbox(0.06, 0.012, 0.004, 0.003), MAT.black, T, [0.03, 0.11, 0.1]); // kiçik ekran
    for (let i = 0; i < 4; i++) mesh(sphere(0.0028), i === 0 ? MAT.ledAmber : MAT.ledGreen, T, [0.012 + i * 0.011, 0.11, 0.103]);
    for (let i = 0; i < 3; i++) mesh(sphere(0.0022), MAT.ledGreen, T, [-0.075 + i * 0.008, 0.095, 0.1]);
    for (let i = 0; i < 4; i++) mesh(rbox(0.07, 0.006, 0.006, 0.002), MAT.black, T, [-0.06, 0.2 - i * 0.012, 0.099]); // havalandırma
    screws(T, [[-0.09, 0.215], [0.09, 0.215], [-0.09, 0.085], [0.09, 0.085]], 0.1);
    mesh(rbox(0.2, 0.05, 0.14, 0.02), MAT.steel, T, [0, 0.005, 0]); // aşağı mexanizm
    mesh(cyl(0.05, 0.05, 0.03), MAT.darkMetal, T, [0, 0.27, 0]); // boyun dayağı

    // Çiyin ankerləri (qolların başlanğıcı)
    this.shoulderAnchors = [-1, 1].map((s) => {
      const a = new THREE.Group();
      a.position.set(s * 0.165, 0.22, 0);
      T.add(a);
      mesh(cyl(0.05, 0.05, 0.05, 32), MAT.darkMetal, a, [s * -0.012, 0, 0], [0, 0, Math.PI / 2]);
      mesh(cyl(0.042, 0.042, 0.056, 32), MAT.paint, a, [s * 0.012, 0, 0], [0, 0, Math.PI / 2]);
      mesh(cyl(0.018, 0.018, 0.06, 16), MAT.steel, a, [s * 0.02, 0, 0], [0, 0, Math.PI / 2]);
      return a;
    });

    // Boyun
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.285, 0);
    T.add(this.neck);
    mesh(cyl(0.032, 0.036, 0.06), MAT.darkMetal, this.neck, [0, 0.03, 0]);
    for (let i = 0; i < 3; i++) mesh(torus(0.035, 0.004), MAT.steel, this.neck, [0, 0.012 + i * 0.018, 0], [Math.PI / 2, 0, 0]);
    cable(T, [-0.075, 0.26, 0.07], [-0.05, 0.345, 0.03], [-0.1, 0.31, 0.08]);
    cable(T, [0.075, 0.26, 0.07], [0.05, 0.345, 0.03], [0.1, 0.31, 0.08]);

    // Baş
    this.head = new THREE.Group();
    this.head.position.set(0, 0.055, 0);
    this.neck.add(this.head);
    this.buildHead(this.head);

    // Qollar
    this.arms = [-1, 1].map((s) => this.buildArm(s));
  }

  buildHead(H) {
    const FZ = 0.11; // üzün ön səthi
    mesh(rbox(0.235, 0.25, 0.22, 0.07), MAT.paint, H, [0, 0.125, 0]);
    mesh(rbox(0.13, 0.045, 0.012, 0.006), MAT.paint, H, [0, 0.215, FZ - 0.003]); // alın paneli
    screws(H, [[-0.05, 0.215], [0.05, 0.215]], FZ + 0.004, 0.004);
    // qulaqlar
    for (const s of [-1, 1]) {
      mesh(cyl(0.04, 0.04, 0.03), MAT.darkMetal, H, [s * 0.12, 0.14, 0], [0, 0, Math.PI / 2]);
      mesh(cyl(0.028, 0.028, 0.034), MAT.steel, H, [s * 0.124, 0.14, 0], [0, 0, Math.PI / 2]);
      mesh(torus(0.033, 0.003), MAT.black, H, [s * 0.137, 0.14, 0], [0, Math.PI / 2, 0]);
    }
    // gözlər
    this.lids = [];
    this.lensGlows = [];
    for (const s of [-1, 1]) {
      const E = new THREE.Group();
      E.position.set(s * 0.052, 0.148, FZ);
      H.add(E);
      mesh(torus(0.034, 0.0075), MAT.steel, E, [0, 0, 0.002]);
      mesh(cyl(0.033, 0.033, 0.02, 32), MAT.black, E, [0, 0, -0.008], [Math.PI / 2, 0, 0]);
      const lens = mesh(new THREE.SphereGeometry(0.027, 32, 16, 0, TAU, 0, Math.PI / 2), MAT.lens, E, [0, 0, -0.006], [Math.PI / 2, 0, 0]);
      lens.scale.y = 0.5;
      mesh(new THREE.CircleGeometry(0.008, 24), MAT.pupil, E, [0, 0, 0.009]);
      // göz qapağı (yuxarıdan aşağı enir)
      const lidGeo = new THREE.CircleGeometry(0.031, 32);
      lidGeo.translate(0, -0.031, 0);
      const lid = mesh(lidGeo, MAT.darkMetal, E, [0, 0.031, 0.012]);
      lid.scale.y = 0.001;
      this.lids.push(lid);
      this.lensGlows.push(glow(E, [0, 0, 0.02], [0.11, 0.11], 0.55));
    }
    // ağız
    const shape = mouthShape();
    const M = new THREE.Group();
    M.position.set(0, 0.052, FZ + 0.001);
    H.add(M);
    const frame = new THREE.Shape(shape.getPoints(48).map((p) => new THREE.Vector2(p.x * 1.025, p.y * 1.04)));
    mesh(new THREE.ShapeGeometry(frame, 24), MAT.black, M, [0, 0, -0.001]);
    this.led = new MouthLED();
    mesh(fitUV(new THREE.ShapeGeometry(shape, 24)), new THREE.MeshBasicMaterial({ map: this.led.tex }), M, [0, 0, 0.0005]);
    const pts = shape.getPoints(64).map((p) => new THREE.Vector3(p.x * 1.03, p.y * 1.06 + 0.0005, 0.002));
    this.rimMat = MAT.rim.clone();
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, 0.0032, 8, true), this.rimMat, M);
    this.mouthGlow = glow(M, [0, -0.002, 0.02], [0.3, 0.12], 0);
    // üzə düşən mavi işıq
    this.faceLight = new THREE.PointLight(0x6db6ff, 0.02, 0.35, 2);
    this.faceLight.position.set(0, 0.1, FZ + 0.05);
    H.add(this.faceLight);
  }

  buildArm(side) {
    const arm = { side };
    arm.upper = mesh(capsule(0.042, 0.11), MAT.paint, this.root);
    arm.upperBand = mesh(cyl(0.044, 0.044, 0.012), MAT.steel, this.root);
    arm.elbow = mesh(sphere(0.04), MAT.steel, this.root);
    arm.elbowCap = mesh(cyl(0.028, 0.028, 0.088, 24), MAT.darkMetal, this.root);
    arm.fore = mesh(capsule(0.038, 0.1), MAT.paint, this.root);
    arm.foreBand = mesh(cyl(0.039, 0.039, 0.01), MAT.steel, this.root);
    arm.hand = new Hand(side);
    this.root.add(arm.hand.group);
    arm.hand.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    arm.cable = null;
    return arm;
  }
}

// ---------------------------------------------------------------- 2 oynaqlı IK
const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function placeBetween(m, a, b, extra = 0) {
  m.position.copy(a).lerp(b, 0.5);
  _v.subVectors(b, a).normalize();
  m.quaternion.setFromUnitVectors(_up, _v);
}
function solveIK(S, T, la, lb, pole) {
  const d = clamp(S.distanceTo(T), 0.02, la + lb - 0.001);
  const dir = new THREE.Vector3().subVectors(T, S).normalize();
  const cosA = clamp((la * la + d * d - lb * lb) / (2 * la * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const E = S.clone().add(dir.multiplyScalar(la * cosA)).add(perp.multiplyScalar(la * sinA));
  const Tc = S.clone().add(new THREE.Vector3().subVectors(T, S).normalize().multiplyScalar(d));
  return { E, T: Tc };
}

// ---------------------------------------------------------------- animasiya beyni
class Animator {
  constructor(robot) {
    this.r = robot;
    this.yaw = new Spring(0, 40, 11);
    this.pitch = new Spring(0, 50, 12);
    this.roll = new Spring(0, 30, 10);
    this.lookYaw = 0; this.lookPitch = 0; this.lookUntil = 0;
    this.nextLook = 6;
    this.blinkT = -1; this.nextBlink = 2;
    this.prevLevel = 0; this.lastBeat = 0;
    this.gestures = []; // {name, start, dur}
    this.handTargets = {
      [-1]: new THREE.Vector3(-0.085, 0.022, 0.25),
      [1]: new THREE.Vector3(0.085, 0.022, 0.25),
    };
    this.cur = { [-1]: this.handTargets[-1].clone(), [1]: this.handTargets[1].clone() };
    this.tapT = 0;
  }

  gesture(name, t) {
    if (name === "glance") { this.lookYaw = rand(-0.15, 0.15); this.lookPitch = -0.16; this.lookUntil = t + 1.1; return; }
    if (name === "nod") { this.pitch.vel += 2.2; setTimeout(() => (this.pitch.vel += 2.0), 330); return; }
    if (name === "shake") { [0, 250, 500].forEach((d, i) => setTimeout(() => (this.yaw.vel += i % 2 ? -3 : 3), d)); return; }
    const dur = { wave: 2.8, talk: rand(1.4, 2.2), talkL: rand(1.2, 1.8) }[name] || 2;
    this.gestures = this.gestures.filter((g) => !(g.name === name));
    this.gestures.push({ name, start: t, dur });
  }

  gestureWeight(g, t) {
    const p = (t - g.start) / g.dur;
    if (p < 0 || p > 1) return 0;
    return ease(clamp(Math.min(p / 0.25, (1 - p) / 0.25), 0, 1));
  }

  update(t, dt, audio) {
    const r = this.r;
    const level = audio.level || 0;
    const speaking = audio.speaking;

    // --- göz qırpma
    if (t > this.nextBlink && this.blinkT < 0) { this.blinkT = 0; this.nextBlink = t + rand(2.5, 6.5); if (Math.random() < 0.2) this.nextBlink = t + 0.35; }
    let lid = 0.001;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / 0.16;
      lid = p < 0.5 ? p * 2 : Math.max(0.001, 2 - p * 2);
      if (p >= 1) this.blinkT = -1;
    }
    r.lids.forEach((l) => (l.scale.y = Math.max(0.001, lid)));

    // --- ətrafa baxma (susanda)
    if (!speaking && t > this.nextLook) {
      const opts = [[-0.45, 0.05], [0.4, 0.02], [0.05, 0.22], [-0.2, -0.05], [0.25, 0.12]];
      const [y, p] = opts[Math.floor(Math.random() * opts.length)];
      this.lookYaw = y; this.lookPitch = p;
      this.lookUntil = t + rand(1.2, 2.6);
      this.nextLook = t + rand(7, 14);
    }
    if (t > this.lookUntil) { this.lookYaw = 0; this.lookPitch = 0; }

    // --- danışarkən başın ritmi (heca zərbələri)
    if (speaking && level - this.prevLevel > 0.1 && t - this.lastBeat > 0.22) {
      this.pitch.vel += rand(0.5, 1.2);
      this.yaw.vel += rand(-0.6, 0.6);
      this.roll.vel += rand(-0.4, 0.4);
      this.lastBeat = t;
      if (Math.random() < 0.05 && !this.gestures.length) this.gesture(Math.random() < 0.65 ? "talk" : "talkL", t);
    }
    this.prevLevel = lerp(this.prevLevel, level, 0.5);

    // --- baş hədəfləri
    const n = speaking ? 0.6 : 1;
    this.yaw.target = this.lookYaw + wobble(t * 0.35, 1) * 0.06 * n;
    this.pitch.target = this.lookPitch + wobble(t * 0.3, 7) * 0.035 + level * 0.05;
    this.roll.target = wobble(t * 0.25, 3) * 0.03 + this.yaw.target * -0.15;
    const yaw = this.yaw.step(dt), pitch = this.pitch.step(dt), roll = this.roll.step(dt);
    r.head.rotation.set(pitch, yaw, roll, "YXZ");
    r.neck.rotation.set(pitch * 0.3, yaw * 0.25, 0);

    // --- nəfəs / servo sakit hərəkəti
    r.torso.rotation.set(Math.sin(t * 1.25) * 0.008 + pitch * 0.08, yaw * 0.18, Math.sin(t * 0.6) * 0.004);
    r.torso.position.y = 0.06 + Math.sin(t * 1.25) * 0.002;

    // --- işıqlar
    const eyeI = 1.0 + 0.08 * Math.sin(t * 1.1) + level * 0.9;
    MAT.lens.emissiveIntensity = eyeI * (lid > 0.5 ? 0.15 : 1);
    r.lensGlows.forEach((g) => (g.material.opacity = (0.35 + level * 0.4) * (1 - lid)));
    r.rimMat.color.setRGB(lerp(0.22, 0.75, level), lerp(0.42, 0.9, level), lerp(0.62, 1.0, level));
    r.mouthGlow.material.opacity = level * 0.55;
    r.faceLight.intensity = 0.01 + level * 0.06;
    r.led.draw(audio.bands || [], 0.1 + 0.04 * Math.sin(t * 1.6));

    // --- qollar
    for (const s of [-1, 1]) {
      const target = this.handTargets[s].clone();
      const pole = new THREE.Vector3(s * 1, -0.5, -0.9);
      let curl = 0.4, roll = 0, pitchHand = 0, flat = 0.9;
      // barmaqla masaya vurma (susanda arabir)
      if (!speaking && s === 1) {
        this.tapT += dt;
        const tp = (this.tapT % 9) - 7;
        if (tp > 0) target.y += Math.abs(Math.sin(tp * Math.PI * 2.5)) * 0.008;
      }
      for (const g of this.gestures) {
        const w = this.gestureWeight(g, t);
        if (!w) continue;
        if (g.name === "wave" && s === 1) {
          const sway = Math.sin((t - g.start) * TAU * 1.6) * 0.06;
          target.lerp(new THREE.Vector3(0.27 + sway, 0.5, 0.1), w);
          pole.lerp(new THREE.Vector3(1, -1, -0.4), w);
          curl = lerp(curl, 0.05, w); roll = lerp(roll, -1.4, w); pitchHand = lerp(0, -0.5, w); flat = lerp(flat, 0, w);
        }
        if (g.name === "talk" && s === 1) {
          const sw = Math.sin((t - g.start) * 3.2) * 0.02;
          target.lerp(new THREE.Vector3(0.12 + sw, 0.13, 0.25), w);
          curl = lerp(curl, 0.2, w); roll = lerp(roll, -1.1, w); flat = lerp(flat, 0.3, w);
        }
        if (g.name === "talkL" && s === -1) {
          const sw = Math.sin((t - g.start) * 2.7) * 0.015;
          target.lerp(new THREE.Vector3(-0.12 + sw, 0.11, 0.25), w);
          curl = lerp(curl, 0.25, w); roll = lerp(roll, 1.0, w); flat = lerp(flat, 0.3, w);
        }
      }
      this.cur[s].lerp(target, 0.25);
      this.placeArm(r.arms[s === -1 ? 0 : 1], this.cur[s], pole, curl, roll, pitchHand, flat, t);
    }
    this.gestures = this.gestures.filter((g) => t - g.start < g.dur);
  }

  placeArm(arm, T, pole, curl, roll, pitchHand, flat, t) {
    const r = this.r;
    const S = new THREE.Vector3();
    r.shoulderAnchors[arm.side === -1 ? 0 : 1].getWorldPosition(S);
    r.root.worldToLocal(S);
    S.x += arm.side * 0.04;
    const la = 0.17, lb = 0.16;
    const { E, T: Tc } = solveIK(S, T, la, lb, pole);
    placeBetween(arm.upper, S, E);
    placeBetween(arm.upperBand, S.clone().lerp(E, 0.2), E);
    arm.upperBand.position.copy(S.clone().lerp(E, 0.22));
    arm.elbow.position.copy(E);
    arm.elbowCap.position.copy(E);
    const side = new THREE.Vector3().subVectors(Tc, E).cross(new THREE.Vector3().subVectors(S, E)).normalize();
    arm.elbowCap.quaternion.setFromUnitVectors(_up, side);
    const W = E.clone().lerp(Tc, 0.86);
    placeBetween(arm.fore, E, W);
    arm.foreBand.position.copy(E.clone().lerp(W, 0.85));
    arm.foreBand.quaternion.copy(arm.fore.quaternion);
    // əl: barmaqlar qolun istiqamətində
    // flat=1: əl masanın üstündə düz uzanır (barmaqlar irəli), 0: qolun istiqamətində
    const z = new THREE.Vector3().subVectors(Tc, E).normalize();
    z.y *= 1 - flat;
    z.normalize();
    const x = new THREE.Vector3().crossVectors(_up, z).normalize();
    if (x.lengthSq() < 1e-4) x.set(1, 0, 0);
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    const hq = new THREE.Quaternion().setFromRotationMatrix(m);
    hq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll + arm.side * 0.15));
    hq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchHand + 0.12));
    arm.hand.group.position.copy(W);
    arm.hand.group.quaternion.copy(hq);
    arm.hand.update(t, curl);
  }
}

// ---------------------------------------------------------------- səhnə
export function startRobot(canvas, stage) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CFG.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  // Masa səviyyəsindən aşağı heç nə çəkilmir (robotun masanın altında qalan hissəsi)
  renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(CFG.fov, 572 / 1024, 0.05, 20);
  camera.position.set(...CFG.cam);
  camera.lookAt(...CFG.look);

  // İşıqlar fotodakı kimi: solda isti lampa, sağda pəncərədən soyuq işıq
  const key = new THREE.DirectionalLight(0xffc68e, 1.9);
  key.position.set(-1.4, 1.5, 1.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -0.7, right: 0.7, top: 0.9, bottom: -0.4, near: 0.1, far: 5 });
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.01;
  scene.add(key);
  const rimL = new THREE.DirectionalLight(0x9cc0ff, 1.6);
  rimL.position.set(1.3, 0.9, -1.2);
  scene.add(rimL);
  const back = new THREE.DirectionalLight(0xffd2a0, 0.7);
  back.position.set(-0.8, 1.2, -1.5);
  scene.add(back);
  scene.add(new THREE.HemisphereLight(0xffe1bd, 0x3a2a1c, 0.35));

  // Masa: görünməz "örtük" (masanın altındakı hissələri gizlədir) + kölgə tutan səth
  const occ = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occ.rotation.x = -Math.PI / 2;
  occ.position.set(0, 0, 1.0);
  occ.renderOrder = -1;
  scene.add(occ);
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), new THREE.ShadowMaterial({ opacity: 0.4 }));
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.set(0, 0.001, 1.0);
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);
  if (CFG.debug) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.004, 0.004), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    scene.add(edge);
  }

  const robot = new Robot(scene);
  const anim = new Animator(robot);
  const clock = new THREE.Clock();

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(stage);

  let acc = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    acc += dt;
    if (acc < 1 / CFG.fps) return;
    const step = acc; acc = 0;
    const t = clock.elapsedTime;
    anim.update(t, step, window.robotAudio || { level: 0, bands: [], speaking: false });
    renderer.render(scene, camera);
  });

  window.robot = { gesture: (name) => anim.gesture(name, clock.elapsedTime) };
  return window.robot;
}
