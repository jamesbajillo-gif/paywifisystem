'use strict';

function fmtBytes(n) {
  if (!n || n < 1024) return (n || 0) + ' B';
  const k = n / 1024;
  if (k < 1024) return k.toFixed(1) + ' KB';
  const m = k / 1024;
  if (m < 1024) return m.toFixed(1) + ' MB';
  return (m / 1024).toFixed(2) + ' GB';
}

function fmtDuration(min) {
  if (!min) return '0 min';
  if (min < 60) return min + ' min';
  if (min < 1440) {
    const h = Math.floor(min / 60), m = min % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }
  if (min < 10080) {
    const d = Math.floor(min / 1440), r = min % 1440;
    return d + ' day' + (d > 1 ? 's' : '') + (r ? ' ' + fmtDuration(r) : '');
  }
  const w = Math.floor(min / 10080), r = min % 10080;
  return w + ' week' + (w > 1 ? 's' : '') + (r ? ' ' + fmtDuration(r) : '');
}

function fmtSpeed(kbps) {
  if (!kbps) return '0 Kbps';
  if (kbps < 1024) return kbps + ' Kbps';
  const mbps = kbps / 1024;
  return (mbps % 1 === 0 ? mbps.toFixed(0) : mbps.toFixed(1)) + ' Mbps';
}

module.exports = { fmtBytes, fmtDuration, fmtSpeed };
