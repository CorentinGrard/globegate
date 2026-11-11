// ─────────────────────────────────────────────
//  Settings drawer + protocol filter
// ─────────────────────────────────────────────
import {
  arcHoldSeconds, setArcHold, filteredIPs, saveFilteredIPs,
  protoFilter, setProtoFilter, clearAllArcs, type ProtoFilter,
} from './arcs.js';
import { esc } from './util.js';
import type { SourceName } from './types.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const settingsPanel = $('settings-panel');
const scrim         = $('scrim');
const arcSlider     = $('hold-slider') as HTMLInputElement;
const arcValEl      = $('hold-val');
const ipInput       = $('ip-input') as HTMLInputElement;
const ipListEl      = $('ip-tags');

// ── Drawer open / close ───────────────────────
function setOpen(open: boolean): void {
  settingsPanel.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
}
$('settings-btn').addEventListener('click', () => setOpen(!settingsPanel.classList.contains('open')));
$('sp-close').addEventListener('click', () => setOpen(false));
scrim.addEventListener('click', () => setOpen(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });

// ── Arc hold slider ───────────────────────────
arcSlider.value = String(arcHoldSeconds);
arcValEl.textContent = `${arcHoldSeconds}s`;
arcSlider.addEventListener('input', () => {
  const v = parseFloat(arcSlider.value);
  setArcHold(v);
  arcValEl.textContent = `${v}s`;
});

// ── IP filter ─────────────────────────────────
function renderIPList(): void {
  ipListEl.innerHTML = [...filteredIPs].map(ip =>
    `<span class="ip-tag">${esc(ip)}<button class="ip-rm" data-ip="${esc(ip)}" aria-label="Remove">×</button></span>`,
  ).join('');
  $('ip-clear-btn').style.display = filteredIPs.size ? '' : 'none';
}
ipListEl.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.ip-rm');
  if (!btn) return;
  filteredIPs.delete(btn.dataset['ip']!);
  saveFilteredIPs();
  renderIPList();
});
$('ip-add-btn').addEventListener('click', () => {
  const val = ipInput.value.trim();
  if (!val) return;
  filteredIPs.add(val);
  saveFilteredIPs();
  ipInput.value = '';
  renderIPList();
});
$('ip-clear-btn').addEventListener('click', () => {
  filteredIPs.clear();
  saveFilteredIPs();
  renderIPList();
});
ipInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('ip-add-btn').click(); });
renderIPList();

// ── Protocol filter (sidebar) ─────────────────
const seg = $('proto-seg');
function renderSeg(): void {
  seg.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.classList.toggle('on', b.dataset['p'] === protoFilter));
}
seg.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  setProtoFilter(b.dataset['p'] as ProtoFilter);
  clearAllArcs();
  renderSeg();
});
renderSeg();

// ── Data sources ──────────────────────────────
const SOURCE_INFO: Record<SourceName, { name: string; desc: string }> = {
  traefik:   { name: 'Traefik access log', desc: 'HTTP(S) requests with service, status and path.' },
  conntrack: { name: 'All TCP / UDP',      desc: 'Every inbound connection to the host (SSH, VPN, games…).' },
  demo:      { name: 'Demo mode',          desc: 'Generated traffic — no real source is configured.' },
};

export function renderSources(active: SourceName[]): void {
  const list: SourceName[] = active.includes('demo') ? ['demo', 'traefik', 'conntrack'] : ['traefik', 'conntrack'];
  $('src-list').innerHTML = list.map(s => {
    const on = active.includes(s);
    const hint = !on && s === 'conntrack'
      ? '<br>Enable with <code>network_mode: host</code> + <code>cap_add: [NET_ADMIN]</code>.'
      : !on && s === 'traefik' ? '<br>Mount the access log at <code>/logs/access.log</code>.' : '';
    return `<div class="src ${on ? 'on' : ''}"><i></i><b>${SOURCE_INFO[s].name}${on ? '' : ' · off'}</b><span>${SOURCE_INFO[s].desc}${hint}</span></div>`;
  }).join('');
}

// ── Version + IP display mode ─────────────────
export function renderAbout(version: string, ipDisplay: string): void {
  $('app-version').textContent = `GlobeGate ${version.startsWith('v') || version === 'dev' ? version : `v${version}`}`;
  if (ipDisplay === 'hidden') {
    $('ip-help').innerHTML = 'The server hides visitor IPs (<code>IP_DISPLAY=hidden</code>), so this filter has nothing to match. Use <code>IGNORE_IPS</code> on the server instead.';
  } else if (ipDisplay === 'masked') {
    $('ip-help').innerHTML = 'IPs are masked by the server (<code>IP_DISPLAY=masked</code>), so filter by range, e.g. <code>203.0.113.0/24</code>. To drop exact IPs for everyone, use <code>IGNORE_IPS</code>.';
  }
}
