import * as THREE from './three.module.js';

/* Earth, as it is right now: the day/night terminator comes from the real
   subsolar point at the visitor's clock, the globe faces North America, and
   it can be dragged sideways. Rendered only while the hero or the closing
   section (the two places the scene shows through) is on screen. */

const canvas = document.getElementById('scene');
if (!canvas) throw new Error('no scene canvas');

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  throw e;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 6000);
const EARTH_R = 10;

const loader = new THREE.TextureLoader();
const tex = (url, cs = THREE.NoColorSpace) => { const t = loader.load(url); t.colorSpace = cs; t.anisotropy = 8; return t; };
const dayMap = tex('assets/img/earth-day.jpg');
const nightMap = tex('assets/img/earth-night.jpg');
const starMap = tex('assets/img/stars-bg.jpg', THREE.SRGBColorSpace);
starMap.mapping = THREE.EquirectangularReflectionMapping;
scene.background = starMap;
scene.backgroundIntensity = 0.5;

/* ---- the subsolar point, low-precision solar ephemeris (good to ~0.5 deg) ---- */
function subsolar(date) {
  const n = date.getTime() / 86400000 - 10957.5;            // days since J2000
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = (357.528 + 0.9856003 * n) % 360 * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24) * 15 * DEG;
  let lon = ra - gmst;
  lon = Math.atan2(Math.sin(lon), Math.cos(lon));
  return { lat: dec, lon };
}
// lat/lon to the sphere's local frame (three's SphereGeometry: lon 0 on +x, east toward -z)
const toLocal = (lat, lon, out = new THREE.Vector3()) =>
  out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));

/* ---- globe ---- */
const tilt = new THREE.Group(); scene.add(tilt);
const spin = new THREE.Group(); tilt.add(spin);
tilt.rotation.x = 0.42;                                       // lean the north toward the camera
const FACE_LON = -95 * DEG;                                    // North America
const baseSpin = -Math.PI / 2 - FACE_LON;
spin.rotation.y = baseSpin;

const sunLocal = new THREE.Vector3();
const sunWorld = new THREE.Vector3();
const earthMat = new THREE.ShaderMaterial({
  uniforms: { dayMap: { value: dayMap }, nightMap: { value: nightMap }, sunDir: { value: sunWorld } },
  vertexShader: `varying vec2 vUv; varying vec3 vN;
    void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir;
    varying vec2 vUv; varying vec3 vN;
    void main(){
      float ndl=dot(normalize(vN), normalize(sunDir));
      float day=smoothstep(-0.16,0.22,ndl);
      vec3 d=texture2D(dayMap,vUv).rgb;
      vec3 n=pow(texture2D(nightMap,vUv).rgb, vec3(2.4))*1.4;
      // a faint floor on the night side so the planet still reads as a planet
      vec3 night=n + d*0.045;
      gl_FragColor=vec4(mix(night, d, day),1.0);
    }`
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 128, 128), earthMat);
spin.add(earth);

const atmo = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R * 1.06, 64, 64),
  new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x6fb3ff) }, sunDir: { value: sunWorld } },
    vertexShader: `varying vec3 vN; varying vec3 vNW;
      void main(){ vN=normalize(normalMatrix*normal); vNW=normalize(mat3(modelMatrix)*normal);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vN; varying vec3 vNW; uniform vec3 uColor; uniform vec3 sunDir;
      void main(){
        float rim=pow(clamp(0.70-dot(vN,vec3(0.0,0.0,1.0)),0.0,1.0),2.2);
        float s=smoothstep(-0.35,0.5,dot(normalize(vNW),normalize(sunDir)));
        gl_FragColor=vec4(uColor,1.0)*clamp(rim*mix(0.3,1.6,s),0.0,1.7);
      }`,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
  })
);
tilt.add(atmo);

/* ---- the network: LEO, an inclined band, and GEO, with traffic moving between them ---- */
const LOW = innerWidth < 760;
const NET = new THREE.Group(); tilt.add(NET);
const NET_C = new THREE.Color(0x5aa9ff), NET_HI = new THREE.Color(0xbcdcff);
const LEO = { r: 11.3, inc: 0.30, raan: 0.40 };
const POLAR = { r: 12.7, inc: 1.30, raan: 1.90 };
const GEO = { r: 15.1, inc: 0.05, raan: 0.00 };
const _e = new THREE.Euler();
function orbitPoint(o, a, out) { out.set(Math.cos(a) * o.r, 0, Math.sin(a) * o.r); _e.set(o.inc, o.raan, 0); return out.applyEuler(_e); }

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(200,225,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
}
const glowTex = glowTexture();
const bandVert = `attribute float t; varying float vT;
  void main(){ vT=t; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const BANDS = [];
function makeBand(o, weight) {
  const N = LOW ? 160 : 360, pos = new Float32Array(N * 3), tt = new Float32Array(N), v = new THREE.Vector3();
  for (let i = 0; i < N; i++) { orbitPoint(o, (i / (N - 1)) * Math.PI * 2, v); pos.set([v.x, v.y, v.z], i * 3); tt[i] = i / (N - 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('t', new THREE.BufferAttribute(tt, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: NET_C }, uOpacity: { value: 0.55 * weight }, uPhase: { value: Math.random() } },
    vertexShader: bandVert,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; uniform float uPhase; varying float vT;
      void main(){ float d=abs(fract(vT-uPhase)-0.5); float p=smoothstep(0.5,0.40,d);
        gl_FragColor=vec4(uColor*(0.65+p), uOpacity*(0.28+0.9*p)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const line = new THREE.Line(g, m);
  line.userData.speed = 0.05 * Math.pow(LEO.r / o.r, 1.5);
  NET.add(line); BANDS.push(line);
}
makeBand(LEO, 1.0); makeBand(POLAR, 0.62); makeBand(GEO, 0.9);

const HUBS = [];
for (const [o, a, s] of [[LEO, 0.6, 0.34], [LEO, 3.4, 0.30], [POLAR, 1.9, 0.26], [GEO, 1.1, 0.36], [GEO, 4.3, 0.30]]) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: NET_HI, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.setScalar(s); orbitPoint(o, a, sp.position); NET.add(sp); HUBS.push({ sp, s, ph: Math.random() * 6.28 });
}

const TRANSFERS = [];
const _mix = { r: 0, inc: 0, raan: 0 };
function transferPoint(a, b, a0, sweep, t, out) {
  const e = t * t * (3 - 2 * t);
  _mix.r = a.r + (b.r - a.r) * e; _mix.inc = a.inc + (b.inc - a.inc) * e; _mix.raan = a.raan + (b.raan - a.raan) * e;
  return orbitPoint(_mix, a0 + sweep * t, out);
}
function makeTransfer(from, to, a0, sweep, speed, phase) {
  const N = LOW ? 30 : 60, tt = new Float32Array(N);
  for (let i = 0; i < N; i++) tt[i] = i / (N - 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('t', new THREE.BufferAttribute(tt, 1));
  const trail = new THREE.Line(g, new THREE.ShaderMaterial({
    uniforms: { uColor: { value: NET_HI }, uOpacity: { value: 0.9 } }, vertexShader: bandVert,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vT;
      void main(){ gl_FragColor=vec4(uColor, uOpacity*pow(vT,2.4)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  head.scale.setScalar(0.3);
  NET.add(trail, head);
  TRANSFERS.push({ from, to, a0, sweep, speed, phase, N, g, head });
}
makeTransfer(LEO, GEO, 0.6, 7.2, 0.055, 0.00);
makeTransfer(GEO, LEO, 4.3, 6.4, 0.045, 0.45);
makeTransfer(LEO, POLAR, 3.4, 5.6, 0.062, 0.72);
const _v = new THREE.Vector3();
function updateTransfers(t) {
  for (const tr of TRANSFERS) {
    const p = (t * tr.speed + tr.phase) % 1, tail = 0.16, arr = tr.g.attributes.position.array;
    for (let i = 0; i < tr.N; i++) {
      const s = clamp(p - tail + tail * (i / (tr.N - 1)), 0, 1);
      transferPoint(tr.from, tr.to, tr.a0, tr.sweep, s, _v); arr[i * 3] = _v.x; arr[i * 3 + 1] = _v.y; arr[i * 3 + 2] = _v.z;
    }
    tr.g.attributes.position.needsUpdate = true;
    transferPoint(tr.from, tr.to, tr.a0, tr.sweep, p, tr.head.position);
    tr.head.material.opacity = Math.sin(p * Math.PI) * 0.95;
  }
}

/* ---- point starfield ---- */
(function stars() {
  const N = 3600, R = 2500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), siz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const th = 2 * Math.PI * Math.random(), ph = Math.acos(2 * Math.random() - 1);
    pos.set([R * Math.sin(ph) * Math.cos(th), R * Math.cos(ph), R * Math.sin(ph) * Math.sin(th)], i * 3);
    const mag = Math.pow(Math.random(), 2.2), b = 0.35 + mag * 0.65;
    col.set([b * 0.92, b * 0.95, b], i * 3); siz[i] = 1 + mag * 2.4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(siz, 1));
  scene.add(new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uPix: { value: Math.min(devicePixelRatio || 1, 1.8) } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uPix;
      void main(){ vC=color; gl_PointSize=size*uPix; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vC; void main(){ vec2 d=gl_PointCoord-0.5; float r=dot(d,d); if(r>0.25) discard;
      gl_FragColor=vec4(vC, smoothstep(0.25,0.04,r)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
})();

/* ---- framing: the planet sits to the right on wide screens, low and centred on phones ---- */
const framing = { x: 0, y: 0, dist: 34 };
function frame() {
  const w = innerWidth, h = innerHeight, a = w / h;
  if (w < 760) { framing.x = 0; framing.y = -9.5; framing.dist = 44; }
  else { framing.x = clamp(a * 5.2, 6, 11); framing.y = -1.0; framing.dist = 31; }
}
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 1.8);
  renderer.setPixelRatio(dpr); renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); frame();
}
addEventListener('resize', resize); resize();

/* ---- drag to turn the planet (horizontal only, so vertical swipes still scroll) ---- */
let dragVel = 0, dragOffset = 0, dragging = false, lastX = 0;
const drag = document.querySelector('[data-earth-drag]');
if (drag) {
  drag.addEventListener('pointerdown', e => {
    if (e.target.closest('a,button,input,select,textarea')) return;
    dragging = true; lastX = e.clientX; drag.setPointerCapture(e.pointerId); drag.classList.add('dragging');
  });
  drag.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    dragOffset += dx * 0.005; dragVel = dx * 0.005;
  });
  const end = () => { dragging = false; drag.classList.remove('dragging'); };
  drag.addEventListener('pointerup', end); drag.addEventListener('pointercancel', end);
}

/* ---- live readout ---- */
const readout = document.getElementById('earth-time');
function tickReadout(d) {
  if (!readout) return;
  const p = n => String(n).padStart(2, '0');
  readout.textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/* ---- render only while the scene can be seen ---- */
const windows = [...document.querySelectorAll('[data-scene-window]')];
const visible = new Set();
const io = new IntersectionObserver(es => { for (const e of es) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target); }, { rootMargin: '10% 0px' });
windows.forEach(w => io.observe(w));

let last = performance.now(), sunAt = 0, started = false;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (started && !visible.size) return;
  const t = now / 1000;

  if (now - sunAt > 30000 || !sunAt) {                       // the sun moves slowly; refresh twice a minute
    const d = new Date(), s = subsolar(d); toLocal(s.lat, s.lon, sunLocal); tickReadout(d); sunAt = now;
  }
  if (!dragging) { dragOffset += dragVel; dragVel *= 0.94; }
  const scrollT = clamp(scrollY / innerHeight, 0, 1.2);
  spin.rotation.y = baseSpin + dragOffset + (REDUCED ? 0 : scrollT * 0.35);

  tilt.updateMatrixWorld(true);
  sunWorld.copy(sunLocal).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion())).normalize();

  if (!REDUCED) {
    for (const b of BANDS) b.material.uniforms.uPhase.value = (b.material.uniforms.uPhase.value + dt * b.userData.speed) % 1;
    for (const h of HUBS) h.sp.scale.setScalar(h.s * (1 + 0.18 * Math.sin(t * 1.6 + h.ph)));
    updateTransfers(t);
    NET.rotation.y = t * 0.01;
  } else if (!started) updateTransfers(1);

  // the hero pulls back a little as it scrolls away
  const pull = REDUCED ? 0 : scrollT * 6;
  camera.position.set(-framing.x, -framing.y + scrollT * 2, framing.dist + pull);
  camera.lookAt(-framing.x, -framing.y + scrollT * 2, 0);
  renderer.render(scene, camera);
  if (!started) { started = true; document.documentElement.classList.add('scene-ready'); }
}
requestAnimationFrame(loop);
