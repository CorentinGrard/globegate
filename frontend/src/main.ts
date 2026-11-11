// ─────────────────────────────────────────────
//  main.ts — application entry point
// ─────────────────────────────────────────────
import '@fontsource-variable/inter/index.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { scene, camera, renderer, loadGlobeTexture, applyMomentum } from './globe';
import { tickArcs }       from './arcs';
import { updateCounters } from './stats';
import { connect }        from './ws';
import { loadDensity }    from './timeline';

// Side-effect imports (register event listeners)
import './settings';

// ── Mount renderer ────────────────────────────
document.getElementById('canvas-container')!.appendChild(renderer.domElement);

// ── Animation loop ────────────────────────────
const clock = { last: performance.now() };
function animate(): void {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt  = Math.min((now - clock.last) / 1000, 0.05); // seconds, capped at 50ms
  clock.last = now;

  applyMomentum();
  tickArcs(dt);
  renderer.render(scene, camera);
}

// ── Boot ──────────────────────────────────────
(async () => {
  try { await loadGlobeTexture(); }
  catch (e) { console.warn('Globe texture failed:', e); }

  document.getElementById('loading')!.classList.add('gone');
  animate();
  connect();

  // Periodic UI refreshes
  setInterval(updateCounters, 5_000);
  setInterval(() => void loadDensity(), 5 * 60_000);
})();