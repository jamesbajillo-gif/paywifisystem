'use strict';
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const cfg = JSON.parse(fs.readFileSync('/etc/paywifi/config.json', 'utf8'));
const db  = new Database(cfg.database.path);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
module.exports.cfg = cfg;
