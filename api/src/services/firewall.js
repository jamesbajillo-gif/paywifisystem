'use strict';
// Wrapper around the paywifi-auth CLI (which manages nft sets).
const { execFileSync } = require('child_process');

const AUTH_BIN = '/usr/local/sbin/paywifi-auth';

function run(args) {
  return execFileSync('sudo', ['-n', AUTH_BIN, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

exports.authorize = (ip, timeoutSeconds) => {
  const args = ['add', ip];
  if (timeoutSeconds) args.push(String(timeoutSeconds));
  return run(args);
};

exports.revoke = (ip) => run(['del', ip]);

exports.list = () => {
  try { return run(['list']); } catch (e) { return ''; }
};

exports.flush = () => run(['flush']);
