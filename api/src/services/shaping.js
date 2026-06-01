'use strict';
// Wrapper around the paywifi-shape CLI.
const { execFileSync } = require('child_process');

const SHAPE_BIN = '/usr/local/sbin/paywifi-shape';

function run(args) {
  return execFileSync('sudo', ['-n', SHAPE_BIN, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

exports.add   = (ip, kbps) => run(['add', ip, String(kbps)]);
exports.del   = (ip)       => run(['del', ip]);
exports.stats = (ip)       => { try { return run(['stats', ip]); } catch (e) { return ''; } };
exports.list  = ()         => { try { return run(['list']); }       catch (e) { return ''; } };
