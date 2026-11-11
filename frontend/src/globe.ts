// ─────────────────────────────────────────────
//  Globe — Three.js scene setup, rendering, interaction
// ─────────────────────────────────────────────
import * as THREE from 'three';
import type { FeatureCollection } from 'geojson';

export const GLOBE_R = 1.0;
const isMobile = window.innerWidth < 641;

// ── Scene / renderer ──────────────────────────
export const scene      = new THREE.Scene();
export const camera     = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 1000);
export const renderer   = new THREE.WebGLRenderer({ antialias: true, alpha: true });
export const globeGroup = new THREE.Group();

/** Camera distance that keeps the whole globe (plus glow) in view for this aspect ratio. */
function fitDistance(): number {
  const aspect = window.innerWidth / window.innerHeight;
  const halfFov = Math.tan((camera.fov / 2) * Math.PI / 180);
  const r = 1.22; // globe + atmosphere, with a little margin
  return Math.max(r / halfFov, r / (halfFov * aspect)) * (aspect < 1 ? 0.92 : 1.0);
}

/** On wide screens shift the globe left so it's centred in the space beside the sidebar. */
function applyViewOffset(): void {
  const W = window.innerWidth, H = window.innerHeight;
  if (W > 1000) camera.setViewOffset(W, H, 150, 0, W, H);
  else camera.clearViewOffset();
}

let zoomMax = 5;
camera.position.z = fitDistance();
zoomMax = Math.max(5, camera.position.z * 1.5);
applyViewOffset();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0); // transparent — CSS gradient shows through
scene.add(globeGroup);

// ── Ocean sphere (dark, with a soft rim light) ──
const oceanMat = new THREE.ShaderMaterial({
  uniforms: {
    uBase: { value: new THREE.Color(0x070b18) },
    uTop:  { value: new THREE.Color(0x0d1530) },
    uRim:  { value: new THREE.Color(0x3a5bd9) },
  },
  vertexShader: /* glsl */`
    varying vec3 vN; varying vec3 vV;
    void main() {
      vN = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uBase; uniform vec3 uTop; uniform vec3 uRim;
    varying vec3 vN; varying vec3 vV;
    void main() {
      float rim = pow(1.0 - max(dot(vN, vV), 0.0), 2.5);
      vec3 c = mix(uBase, uTop, smoothstep(-0.6, 0.9, vN.y));
      c += uRim * rim * 0.55;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
globeGroup.add(new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 96, 96), oceanMat));

// ── Atmosphere glow (outside the globe, not rotating) ──
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(GLOBE_R * 1.18, 96, 96),
  new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x4a74ff) } },
    vertexShader: /* glsl */`
      varying vec3 vN;
      void main() {
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying vec3 vN;
      void main() {
        // Back faces: -vN.z is 0 at the outer edge and ~0.53 where the glow meets the globe
        float i = pow(clamp(-vN.z / 0.55, 0.0, 1.0), 3.0);
        gl_FragColor = vec4(uColor * 0.9, i); // alpha = intensity, so the canvas stays transparent
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  }),
));

// ── Stars ─────────────────────────────────────
{
  const N = isMobile ? 900 : 1800;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 60 + Math.random() * 120;
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({
    color: 0xb8c4ff, size: 0.18, transparent: true, opacity: 0.35, depthWrite: false,
  })));
}

// ── Geo math ──────────────────────────────────
export function ll2v(lat: number, lon: number, r = GLOBE_R): THREE.Vector3 {
  const phi   = (90 - lat)  * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  );
}

// ── Shared soft-glow sprite texture ───────────
export const glowTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0,   'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1,   'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

export function makeGlow(color: THREE.ColorRepresentation, size: number, opacity = 1): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  s.scale.setScalar(size);
  return s;
}

// ── Server marker ─────────────────────────────
export const SERVER_COLOR = new THREE.Color(0x34d399);
let serverPos: THREE.Vector3 | null = null;
let serverMarker: THREE.Group | null = null;

export function getServerPos(): THREE.Vector3 | null { return serverPos; }

export function placeServerMarker(lat: number, lon: number): void {
  if (serverMarker) globeGroup.remove(serverMarker);
  serverPos = ll2v(lat, lon, GLOBE_R + 0.004);

  serverMarker = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.009, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xd1fae5 }),
  );
  core.position.copy(serverPos);
  const glow = makeGlow(SERVER_COLOR, 0.11, 0.9);
  glow.position.copy(serverPos);
  serverMarker.add(core, glow);
  globeGroup.add(serverMarker);
}

// ── Globe orientation ─────────────────────────
export function orientGlobe(lat: number, lon: number): void {
  globeGroup.rotation.y = -(lon + 90) * Math.PI / 180;
  globeGroup.rotation.x =  lat        * Math.PI / 180 * 0.6;
}

// ── Drag + momentum ───────────────────────────
let isDrag = false;
let prevM  = { x: 0, y: 0 };
let momX   = 0;
let momY   = 0;

export function applyMomentum(): void {
  if (isDrag) return;
  momX *= 0.92; momY *= 0.92;
  if (Math.abs(momX) < 1e-5 && Math.abs(momY) < 1e-5) return;
  globeGroup.rotation.y += momX;
  globeGroup.rotation.x  = Math.max(-1.2, Math.min(1.2, globeGroup.rotation.x + momY));
}

function startDrag(x: number, y: number): void { isDrag = true; prevM = { x, y }; momX = momY = 0; }
function moveDrag (x: number, y: number): void {
  if (!isDrag) return;
  const k = camera.position.z / 2.9; // rotate slower when zoomed in
  momX = (x - prevM.x) * 0.005 * k;
  momY = (y - prevM.y) * 0.003 * k;
  globeGroup.rotation.y += momX;
  globeGroup.rotation.x  = Math.max(-1.2, Math.min(1.2, globeGroup.rotation.x + momY));
  prevM = { x, y };
}
function endDrag(): void { isDrag = false; }

const container = document.getElementById('canvas-container')!;
container.addEventListener('mousedown', e => startDrag(e.clientX, e.clientY));
window.addEventListener('mousemove',    e => moveDrag(e.clientX, e.clientY));
window.addEventListener('mouseup',      endDrag);

let lastPinchDist = 0;
container.addEventListener('touchstart', e => {
  if (e.touches.length === 1) startDrag(e.touches[0]!.clientX, e.touches[0]!.clientY);
  else if (e.touches.length === 2) {
    isDrag = false;
    lastPinchDist = Math.hypot(
      e.touches[0]!.clientX - e.touches[1]!.clientX,
      e.touches[0]!.clientY - e.touches[1]!.clientY,
    );
  }
}, { passive: true });

container.addEventListener('touchmove', e => {
  if (e.touches.length === 1) {
    moveDrag(e.touches[0]!.clientX, e.touches[0]!.clientY);
  } else if (e.touches.length === 2) {
    const d = Math.hypot(
      e.touches[0]!.clientX - e.touches[1]!.clientX,
      e.touches[0]!.clientY - e.touches[1]!.clientY,
    );
    camera.position.z = Math.max(1.5, Math.min(zoomMax, camera.position.z - (d - lastPinchDist) * 0.008));
    lastPinchDist = d;
  }
}, { passive: true });

container.addEventListener('touchend', endDrag, { passive: true });

// Scroll to zoom (only over the globe, not over panels)
container.addEventListener('wheel', e => {
  camera.position.z = Math.max(1.5, Math.min(zoomMax, camera.position.z + e.deltaY * 0.0015));
}, { passive: true });

// Resize
const resizeHandlers: (() => void)[] = [];
export function onResize(fn: () => void): void { resizeHandlers.push(fn); }
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  zoomMax = Math.max(5, fitDistance() * 1.5);
  camera.position.z = Math.min(camera.position.z, zoomMax);
  applyViewOffset();
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeHandlers.forEach(fn => fn());
});

// ── Land: dotted continents ───────────────────
function getRings(f: GeoJSON.Feature): number[][][] {
  const g = f.geometry;
  if (g.type === 'Polygon')      return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat(1);
  return [];
}

/** Rasterise land polygons into an equirectangular mask we can sample. */
function buildLandMask(geo: FeatureCollection, W: number, H: number): (lat: number, lon: number) => boolean {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  for (const f of geo.features) {
    ctx.beginPath();
    for (const ring of getRings(f)) {
      ring.forEach(([lon, lat], i) => {
        const x = ((lon ?? 0) + 180) / 360 * W;
        const y = (90 - (lat ?? 0)) / 180 * H;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const data = ctx.getImageData(0, 0, W, H).data;
  return (lat, lon) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor((lon + 180) / 360 * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 180 * H)));
    return data[(y * W + x) * 4]! > 128;
  };
}

export async function loadGlobeTexture(): Promise<void> {
  document.getElementById('load-msg')!.textContent = 'Painting globe…';
  const geo: FeatureCollection = await fetch('/ne_110m_land.geojson').then(r => r.json());
  const isLand = buildLandMask(geo, 2048, 1024);

  // Evenly spaced points on the sphere (Fibonacci lattice), kept where there's land
  const N      = isMobile ? 40_000 : 90_000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const y   = 1 - (i / (N - 1)) * 2;
    const lat = Math.asin(y) * 180 / Math.PI;
    const lon = ((((i * golden) * 180 / Math.PI) % 360) + 540) % 360 - 180;
    if (isLand(lat, lon)) pts.push(ll2v(lat, lon, GLOBE_R + 0.0015));
  }

  const dotGeo = new THREE.CircleGeometry(isMobile ? 0.0042 : 0.0031, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const mesh   = new THREE.InstancedMesh(dotGeo, dotMat, pts.length);
  const dummy  = new THREE.Object3D();
  const base   = new THREE.Color(0x7d93d6);
  const tmp    = new THREE.Color();
  pts.forEach((p, i) => {
    dummy.position.copy(p);
    dummy.lookAt(p.clone().multiplyScalar(2));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    // subtle brightness variation so the land has texture
    mesh.setColorAt(i, tmp.copy(base).multiplyScalar(0.65 + Math.random() * 0.4));
  });
  mesh.instanceMatrix.needsUpdate = true;
  globeGroup.add(mesh);
}
