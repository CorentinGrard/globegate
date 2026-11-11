// ─────────────────────────────────────────────
//  Status chip in the top bar (live / reconnecting / history)
// ─────────────────────────────────────────────
const chip = document.getElementById('status')!;
const txt  = document.getElementById('status-txt')!;

let wsState: 'live' | 'off' = 'off';
let historyLabel: string | null = null;

function render(): void {
  if (historyLabel) { chip.className = 'status glass hist'; txt.textContent = historyLabel; return; }
  chip.className = `status glass ${wsState === 'live' ? '' : 'off'}`;
  txt.textContent = wsState === 'live' ? 'Live' : 'Reconnecting…';
}

export function setStatus(s: 'live' | 'off'): void { wsState = s; render(); }
export function setHistoryLabel(label: string | null): void { historyLabel = label; render(); }
