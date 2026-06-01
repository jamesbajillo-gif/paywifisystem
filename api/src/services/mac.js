'use strict';
// Resolve a client IP to its MAC address using /proc/net/arp.
// If not present in ARP cache, attempt to ping it to populate.
const fs = require('fs');
const { execFileSync } = require('child_process');

function readArp() {
  // Format: IP HWtype Flags HWaddress Mask Device
  const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
  const map = new Map();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [ip, , flags, mac] = cols;
    if (mac && mac !== '00:00:00:00:00:00' && flags !== '0x0') {
      map.set(ip, mac.toLowerCase());
    }
  }
  return map;
}

function macForIp(ip) {
  let arp = readArp();
  if (arp.has(ip)) return arp.get(ip);
  // IPv4 validation before ping to prevent injection
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    try { execFileSync('ping', ['-c1', '-W1', ip], { stdio: 'ignore' }); } catch (e) {}
  }
  arp = readArp();
  return arp.get(ip) || null;
}

module.exports = { macForIp };
