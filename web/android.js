// İnsan üzlü android: real fotodan "danışan foto" (WebGL)
//
// 3 foto istifadə olunur (eyni kadr): ağız bağlı, ağız açıq, gözlər bağlı.
// Şeyder hər kadrda:
//   - bağlı və açıq ağız arasında morph edir (çənə səsə görə real kimi enib-qalxır)
//   - göz qırpır
//   - başı azca tərpədir (baş ilə "hə", yana baxma, danışarkən ritm), gövdə nəfəs alır
// Koordinatlar mənbə şəklin pikselləridir (572x1024).
//
// Səhifə hər kadrda window.robotAudio = { level, bands, speaking } verir.
// Xaricdən: window.robot.gesture("nod" | "shake" | "glance" | "wave")

const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uBase, uOpen, uBlink;
uniform float uMouth, uBlinkAmt, uRot, uBreath;
uniform vec2 uOff;
const vec2 SZ = vec2(572.0, 1024.0);

float ell(vec2 p, vec2 c, vec2 r, float f) {
  float l = length((p - c) / r);
  return 1.0 - smoothstep(1.0 - f, 1.0, l);
}
vec3 tex(sampler2D t, vec2 p) { return texture(t, p / SZ).rgb; }

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * SZ;

  // Nəfəs: çiyinlər və döş çox azca qalxıb-enir
  float body = smoothstep(465.0, 520.0, p.y) * (1.0 - smoothstep(740.0, 800.0, p.y))
             * (1.0 - smoothstep(190.0, 250.0, abs(p.x - 300.0)));
  p.y -= uBreath * body;

  // Baş: boyun nöqtəsi ətrafında fırlanma + sürüşmə (yalnız baş maskası daxilində)
  float hm = ell(p, vec2(300.0, 365.0), vec2(84.0, 128.0), 0.3);
  vec2 piv = vec2(300.0, 475.0);
  float a = -uRot * hm;
  vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * (p - piv) + piv;
  q -= uOff * hm;

  // Ağız/çənə morph: bağlı şəkil aşağı, açıq şəkil yuxarı əyilir, sonra qarışdırılır
  float jaw = smoothstep(413.0, 425.0, q.y) * (1.0 - smoothstep(472.0, 508.0, q.y))
            * (1.0 - smoothstep(34.0, 60.0, abs(q.x - 300.0)));
  float amt = mix(15.0, 9.0, smoothstep(424.0, 460.0, q.y));
  vec3 closedW = tex(uBase, q - vec2(0.0, uMouth * amt * jaw));
  vec3 openW   = tex(uOpen, q + vec2(0.0, (1.0 - uMouth) * amt * jaw));
  float mm = ell(q, vec2(300.0, 442.0), vec2(64.0, 60.0), 0.35);
  vec3 col = mix(tex(uBase, q), mix(closedW, openW, smoothstep(0.15, 0.7, uMouth)), mm);

  // Göz qırpma
  float em = max(ell(q, vec2(271.0, 356.0), vec2(17.0, 10.5), 0.5), ell(q, vec2(326.0, 356.0), vec2(17.0, 10.5), 0.5));
  col = mix(col, tex(uBlink, q), em * uBlinkAmt);

  outColor = vec4(col, 1.0);
}`;

const FORCE_MOUTH = new URLSearchParams(location.search).has("mouth") ? Number(new URLSearchParams(location.search).get("mouth")) : null;

// ---------------------------------------------------------------- köməkçilər
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const wobble = (t, s) =>
  Math.sin(t * 0.71 + s) * 0.5 + Math.sin(t * 1.37 + s * 1.9) * 0.3 + Math.sin(t * 2.93 + s * 3.1) * 0.2;

class Spring {
  constructor(k = 40, d = 11) { this.v = 0; this.vel = 0; this.k = k; this.d = d; this.target = 0; }
  step(dt) {
    this.vel += (this.k * (this.target - this.v) - this.d * this.vel) * dt;
    this.v += this.vel * dt;
    return this.v;
  }
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// ---------------------------------------------------------------- başlanğıc
export async function startAndroid(canvas, stage) {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL2 yoxdur");

  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const [base, open, blink] = await Promise.all([
    loadImage("/static/assets/android_base.jpg"),
    loadImage("/static/assets/android_open.jpg"),
    loadImage("/static/assets/android_blink.jpg"),
  ]);
  [base, open, blink].forEach((img, i) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  });
  const U = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(U("uBase"), 0);
  gl.uniform1i(U("uOpen"), 1);
  gl.uniform1i(U("uBlink"), 2);
  const uMouth = U("uMouth"), uBlinkAmt = U("uBlinkAmt"), uRot = U("uRot"), uOff = U("uOff"), uBreath = U("uBreath");

  function resize() {
    const w = Math.min(1080, stage.clientWidth), h = Math.round(w * 1024 / 572);
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  new ResizeObserver(resize).observe(stage);

  // ---------------------------------------------------------------- animasiya
  const yaw = new Spring(35, 10), pitch = new Spring(45, 11), roll = new Spring(30, 10);
  let mouth = 0, mouthScale = 1, prevLevel = 0, lastBeat = 0;
  let blinkT = -1, nextBlink = 1.5;
  let lookX = 0, lookY = 0, lookUntil = 0, nextLook = 5;
  const t0 = performance.now();
  let last = t0;

  function gesture(name) {
    const t = (performance.now() - t0) / 1000;
    if (name === "glance") { lookX = rand(-1.5, 1.5); lookY = -2.2; lookUntil = t + 1.0; }
    if (name === "nod" || name === "wave") { pitch.vel += 30; setTimeout(() => (pitch.vel += 26), 340); }
    if (name === "shake") [0, 260, 520].forEach((d, i) => setTimeout(() => (yaw.vel += i % 2 ? -40 : 40), d));
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    const t = (now - t0) / 1000;
    const A = window.robotAudio || { level: 0, speaking: false };
    const level = A.speaking ? A.level : 0;

    // Ağız: səs gücünə görə, hər hecada açılma dərəcəsi azca fərqli
    if (A.speaking && level - prevLevel > 0.08 && t - lastBeat > 0.16) {
      mouthScale = rand(0.65, 1.05);
      lastBeat = t;
      pitch.vel += rand(4, 10);          // heca ilə başın kiçik "vurğusu"
      yaw.vel += rand(-6, 6);
      roll.vel += rand(-0.02, 0.02);
    }
    prevLevel += (level - prevLevel) * 0.5;
    const target = clamp(Math.pow(level, 0.8) * 1.25 * mouthScale, 0, 1);
    mouth += (target - mouth) * (target > mouth ? 0.55 : 0.3);
    if (FORCE_MOUTH !== null) mouth = FORCE_MOUTH; // test: ?mouth=0..1

    // Göz qırpma (bəzən ard-arda iki dəfə)
    if (t > nextBlink && blinkT < 0) { blinkT = 0; nextBlink = t + (Math.random() < 0.15 ? 0.3 : rand(2.5, 6)); }
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      const p = blinkT / 0.17;
      blink = p < 0.4 ? p / 0.4 : Math.max(0, 1 - (p - 0.4) / 0.6);
      if (p >= 1) blinkT = -1;
    }

    // Susanda arabir ətrafa baxır
    if (!A.speaking && t > nextLook) {
      const opts = [[-2.5, 0.5], [2.5, 0.3], [0.5, 1.8], [-1.5, -0.8]];
      [lookX, lookY] = opts[Math.floor(Math.random() * opts.length)];
      lookUntil = t + rand(1.2, 2.5);
      nextLook = t + rand(7, 13);
    }
    if (t > lookUntil) { lookX = 0; lookY = 0; }

    const calm = A.speaking ? 0.7 : 1;
    yaw.target = lookX + wobble(t * 0.35, 1) * 0.9 * calm;
    pitch.target = lookY + wobble(t * 0.3, 7) * 0.6 + level * 0.8;
    roll.target = wobble(t * 0.25, 3) * 0.008 + yaw.target * -0.002;
    const ox = yaw.step(dt), oy = pitch.step(dt), r = roll.step(dt);

    gl.uniform1f(uMouth, mouth);
    gl.uniform1f(uBlinkAmt, blink);
    gl.uniform1f(uRot, r);
    gl.uniform2f(uOff, ox, oy);
    gl.uniform1f(uBreath, Math.sin(t * 1.3) * 0.7);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.robot = { gesture };
  return window.robot;
}
