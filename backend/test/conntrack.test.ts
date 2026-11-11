import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConntrackLine, toParsedLine } from '../src/sources/conntrack.js';

const tcpSyn  = '    [NEW] tcp      6 120 SYN_SENT src=203.0.113.9 dst=192.168.1.10 sport=51234 dport=22 [UNREPLIED] src=192.168.1.10 dst=203.0.113.9 sport=22 dport=51234';
const tcpEst  = ' [UPDATE] tcp      6 432000 ESTABLISHED src=203.0.113.9 dst=192.168.1.10 sport=51234 dport=22 src=192.168.1.10 dst=203.0.113.9 sport=22 dport=51234 [ASSURED]';
const udpNew  = '    [NEW] udp      17 30 src=198.51.100.7 dst=192.168.1.10 sport=40112 dport=51820 [UNREPLIED] src=192.168.1.10 dst=198.51.100.7 sport=51820 dport=40112';
const udpOut  = '    [NEW] udp      17 30 src=192.168.1.10 dst=8.8.8.8 sport=40112 dport=53 [UNREPLIED] src=8.8.8.8 dst=192.168.1.10 sport=53 dport=40112';
const https6  = ' [UPDATE] tcp      6 432000 ESTABLISHED src=2001:db8::5 dst=2001:db8:1::10 sport=50000 dport=443 src=2001:db8:1::10 dst=2001:db8::5 sport=443 dport=50000 [ASSURED]';
const mc6     = ' [UPDATE] tcp      6 432000 ESTABLISHED src=2001:db8::6 dst=2001:db8:1::10 sport=50000 dport=25565 src=2001:db8:1::10 dst=2001:db8::6 sport=25565 dport=50000 [ASSURED]';

test('parses conntrack event lines', () => {
  assert.deepEqual(parseConntrackLine(tcpEst), {
    kind: 'UPDATE', proto: 'tcp', state: 'ESTABLISHED',
    src: '203.0.113.9', dst: '192.168.1.10', sport: 51234, dport: 22,
  });
  assert.equal(parseConntrackLine(udpNew)?.state, '');
  assert.equal(parseConntrackLine('random noise'), null);
});

test('TCP is only reported once the handshake completes', () => {
  const now = 1_000_000;
  assert.equal(toParsedLine(parseConntrackLine(tcpSyn)!, now), null);
  assert.deepEqual(toParsedLine(parseConntrackLine(tcpEst)!, now), {
    ip: '203.0.113.9', router: 'ssh', status: 0, method: '', path: '', proto: 'tcp', port: 22,
  });
});

test('same IP + port is de-duplicated within the window', () => {
  const now = 2_000_000;
  const ev = parseConntrackLine(udpNew)!;
  assert.equal(toParsedLine(ev, now)?.router, 'wireguard');
  assert.equal(toParsedLine(ev, now + 1_000), null);
  assert.equal(toParsedLine(ev, now + 60_000)?.router, 'wireguard');
});

test('ignores outbound traffic and ports covered by Traefik', () => {
  assert.equal(toParsedLine(parseConntrackLine(udpOut)!), null);
  assert.equal(toParsedLine(parseConntrackLine(https6)!), null);
  assert.equal(toParsedLine(parseConntrackLine(mc6)!)?.router, 'minecraft');
});
