#!/usr/bin/env bash
# =============================================================================
#  paywifi-bootstrap.sh
#  Interactive bootstrap for the PAYWIFI Hotspot System (Debian 12)
#  - Checks prerequisites
#  - Prompts before installing missing packages
#  - Scaffolds directory structure
#  - Initialises SQLite database + seeds default data
# =============================================================================
#  Usage:  sudo bash paywifi-bootstrap.sh
# =============================================================================

set -o pipefail

# ----- Branding --------------------------------------------------------------
APP_NAME="PAYWIFI"
APP_SLUG="paywifi"
APP_TAGLINE="Pay-as-you-go WiFi Hotspot System"

# ----- Config (edit defaults here if needed) ---------------------------------
PAYWIFI_USER="${APP_SLUG}"
PAYWIFI_HOME="/opt/${APP_SLUG}"
PAYWIFI_DB_DIR="/var/lib/${APP_SLUG}"
PAYWIFI_DB_FILE="${PAYWIFI_DB_DIR}/${APP_SLUG}.db"
PAYWIFI_LOG_DIR="/var/log/${APP_SLUG}"
PAYWIFI_CFG_DIR="/etc/${APP_SLUG}"

LAN_IFACE_DEFAULT="eth1"
WAN_IFACE_DEFAULT="eth0"
LAN_SUBNET_DEFAULT="10.10.0.0/24"
LAN_GATEWAY_DEFAULT="10.10.0.1"
LAN_DHCP_START_DEFAULT="10.10.0.100"
LAN_DHCP_END_DEFAULT="10.10.0.250"

NODE_MAJOR="20"   # Node.js LTS

REQUIRED_PKGS=(
  curl
  git
  build-essential
  ca-certificates
  sqlite3
  nginx
  dnsmasq
  nftables
  ipset
  iproute2
  iptables
  net-tools
  jq
  openssl
  sudo
  cron
)

# ----- Colours / helpers -----------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLU=$'\e[34m'
  C_CYN=$'\e[36m'; C_MAG=$'\e[35m'
  C_BLD=$'\e[1m';  C_RST=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_CYN=""; C_MAG=""; C_BLD=""; C_RST=""
fi

info()  { echo "${C_BLU}[INFO]${C_RST}  $*"; }
ok()    { echo "${C_GRN}[ OK ]${C_RST}  $*"; }
warn()  { echo "${C_YLW}[WARN]${C_RST}  $*"; }
err()   { echo "${C_RED}[FAIL]${C_RST}  $*" >&2; }
hr()    { echo "${C_BLD}--------------------------------------------------------------------${C_RST}"; }
title() { hr; echo "${C_BLD} $* ${C_RST}"; hr; }

banner() {
  echo "${C_CYN}${C_BLD}"
  cat <<'BANNER'
  ____   _____  __     __ __        __ ___  _____  ___
 |  _ \ |  _  | \ \   / / \ \      / /|_ _||  ___||_ _|
 | |_) || |_| |  \ \ / /   \ \ /\ / /  | | | |_    | |
 |  __/ |  _  |   \ V /     \ V  V /   | | |  _|   | |
 |_|    |_| |_|    |_|       \_/\_/   |___||_|    |___|
BANNER
  echo "${C_RST}${C_MAG}              ${APP_TAGLINE}${C_RST}"
  echo
}

confirm() {
  # confirm "Question" [default Y|N]
  local prompt="$1"
  local default="${2:-Y}"
  local hint="[Y/n]"
  [[ "$default" == "N" ]] && hint="[y/N]"
  local reply
  read -r -p "${C_YLW}?${C_RST} ${prompt} ${hint} " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

prompt_default() {
  # prompt_default "Question" "default"
  local q="$1" def="$2" reply
  read -r -p "${C_YLW}?${C_RST} ${q} [${def}]: " reply
  echo "${reply:-$def}"
}

die() { err "$*"; exit 1; }

# ----- Pre-flight checks -----------------------------------------------------
preflight_root() {
  if [[ "$EUID" -ne 0 ]]; then
    die "This script must be run as root.  Try: sudo bash $0"
  fi
}

preflight_os() {
  if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect OS — /etc/os-release missing."
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "$ID" != "debian" ]]; then
    warn "Detected OS: $PRETTY_NAME"
    warn "${APP_NAME} targets Debian 12 (Bookworm).  Other distros may break."
    confirm "Continue anyway?" "N" || die "Aborted by user."
  else
    ok "OS: $PRETTY_NAME"
  fi
}

preflight_arch() {
  local arch; arch=$(uname -m)
  case "$arch" in
    x86_64|amd64|aarch64|arm64) ok "Architecture: $arch" ;;
    *) warn "Unusual architecture: $arch. Node.js binaries may not be available." ;;
  esac
}

preflight_resources() {
  local mem_kb cpu_n disk_avail_mb
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  cpu_n=$(nproc)
  disk_avail_mb=$(df --output=avail -m / | tail -n1 | tr -d ' ')

  info "CPU cores : $cpu_n"
  info "Memory    : $((mem_kb/1024)) MB"
  info "Disk free : ${disk_avail_mb} MB on /"

  (( cpu_n < 2 ))           && warn "Less than 2 CPU cores — performance may suffer."
  (( mem_kb < 1800000 ))    && warn "Less than ~2 GB RAM — consider increasing VM memory."
  (( disk_avail_mb < 5000 ))&& warn "Less than 5 GB free disk — consider expanding."
}

preflight_network_ifaces() {
  info "Detected network interfaces:"
  ip -brief link show | grep -v '^lo' | awk '{print "   - " $1 "  (" $2 ")"}'
  echo
  warn "${APP_NAME} needs TWO interfaces: one WAN (internet) + one LAN (clients)."
}

# ----- Package management ----------------------------------------------------
check_packages() {
  title "Checking required packages"
  MISSING_PKGS=()
  for p in "${REQUIRED_PKGS[@]}"; do
    if dpkg -s "$p" >/dev/null 2>&1; then
      ok "$p installed"
    else
      err "$p missing"
      MISSING_PKGS+=("$p")
    fi
  done
}

install_packages() {
  if (( ${#MISSING_PKGS[@]} == 0 )); then
    ok "All required apt packages are present."
    return 0
  fi
  echo
  warn "Missing packages: ${MISSING_PKGS[*]}"
  if confirm "Install them now via apt?"; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING_PKGS[@]}" \
      || die "apt install failed."
    ok "Packages installed."
  else
    die "Cannot continue without required packages."
  fi
}

check_nodejs() {
  title "Checking Node.js (>= ${NODE_MAJOR}.x)"
  if command -v node >/dev/null 2>&1; then
    local v; v=$(node -v | sed 's/^v//; s/\..*//')
    if (( v >= NODE_MAJOR )); then
      ok "Node.js $(node -v) installed"
      return 0
    fi
    warn "Node.js $(node -v) is older than required v${NODE_MAJOR}.x"
  else
    err "Node.js not installed"
  fi
  if confirm "Install/upgrade Node.js v${NODE_MAJOR}.x from NodeSource?"; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
      || die "NodeSource setup failed."
    apt-get install -y nodejs || die "Node.js install failed."
    ok "Node.js $(node -v) installed."
  else
    die "Node.js v${NODE_MAJOR}.x is required."
  fi
}

check_kernel_modules() {
  title "Checking kernel features"
  if ! grep -q '^net.ipv4.ip_forward *= *1' /etc/sysctl.conf /etc/sysctl.d/*.conf 2>/dev/null; then
    warn "IP forwarding is not persistently enabled."
    if confirm "Enable net.ipv4.ip_forward=1 now and persist it?"; then
      echo "net.ipv4.ip_forward=1" >"/etc/sysctl.d/99-${APP_SLUG}.conf"
      sysctl -w net.ipv4.ip_forward=1 >/dev/null
      ok "IP forwarding enabled."
    else
      warn "Skipping — you must enable this before running the gateway."
    fi
  else
    ok "IP forwarding already persisted."
  fi

  if ! lsmod | grep -q '^ip_tables\|^nf_tables'; then
    warn "Netfilter modules not yet loaded — they will load on first use."
  else
    ok "Netfilter modules present."
  fi
}

# ----- Filesystem scaffolding ------------------------------------------------
create_user() {
  title "Creating service user"
  if id "$PAYWIFI_USER" >/dev/null 2>&1; then
    ok "User '$PAYWIFI_USER' exists."
  else
    if confirm "Create system user '$PAYWIFI_USER'?"; then
      useradd --system --home "$PAYWIFI_HOME" --shell /usr/sbin/nologin "$PAYWIFI_USER"
      ok "User created."
    fi
  fi
}

create_dirs() {
  title "Creating directory layout"
  local dirs=(
    "$PAYWIFI_HOME"
    "$PAYWIFI_HOME/api/src/routes"
    "$PAYWIFI_HOME/api/src/services"
    "$PAYWIFI_HOME/api/src/middleware"
    "$PAYWIFI_HOME/api/src/workers"
    "$PAYWIFI_HOME/api/db"
    "$PAYWIFI_HOME/portal"
    "$PAYWIFI_HOME/admin/views"
    "$PAYWIFI_HOME/admin/public"
    "$PAYWIFI_HOME/scripts"
    "$PAYWIFI_DB_DIR"
    "$PAYWIFI_LOG_DIR"
    "$PAYWIFI_CFG_DIR"
  )
  for d in "${dirs[@]}"; do
    mkdir -p "$d"
    ok "ensured: $d"
  done
  chown -R "$PAYWIFI_USER":"$PAYWIFI_USER" "$PAYWIFI_HOME" "$PAYWIFI_DB_DIR" "$PAYWIFI_LOG_DIR" 2>/dev/null || true
}

# ----- Config file -----------------------------------------------------------
write_config() {
  title "System configuration"
  local cfg="$PAYWIFI_CFG_DIR/config.json"
  if [[ -f "$cfg" ]]; then
    warn "$cfg already exists."
    if ! confirm "Overwrite it?" "N"; then
      ok "Keeping existing config."
      return
    fi
  fi

  local wan lan subnet gw dhcp_start dhcp_end
  wan=$(prompt_default "WAN interface name"     "$WAN_IFACE_DEFAULT")
  lan=$(prompt_default "LAN interface name"     "$LAN_IFACE_DEFAULT")
  subnet=$(prompt_default "LAN subnet (CIDR)"   "$LAN_SUBNET_DEFAULT")
  gw=$(prompt_default "LAN gateway IP"          "$LAN_GATEWAY_DEFAULT")
  dhcp_start=$(prompt_default "DHCP range start" "$LAN_DHCP_START_DEFAULT")
  dhcp_end=$(prompt_default "DHCP range end"     "$LAN_DHCP_END_DEFAULT")

  local jwt_secret; jwt_secret=$(openssl rand -hex 32)

  cat >"$cfg" <<EOF
{
  "app": {
    "name":    "${APP_NAME}",
    "slug":    "${APP_SLUG}",
    "tagline": "${APP_TAGLINE}"
  },
  "network": {
    "wan_iface":   "${wan}",
    "lan_iface":   "${lan}",
    "lan_subnet":  "${subnet}",
    "lan_gateway": "${gw}",
    "dhcp_start":  "${dhcp_start}",
    "dhcp_end":    "${dhcp_end}"
  },
  "api": {
    "port": 3000,
    "jwt_secret": "${jwt_secret}",
    "jwt_expiry_hours": 12
  },
  "database": {
    "path": "${PAYWIFI_DB_FILE}"
  },
  "logging": {
    "dir": "${PAYWIFI_LOG_DIR}",
    "level": "info"
  },
  "captive_portal": {
    "redirect_host": "${gw}",
    "redirect_port": 80
  }
}
EOF
  chmod 640 "$cfg"
  chown root:"$PAYWIFI_USER" "$cfg" 2>/dev/null || true
  ok "Wrote $cfg"
}

# ----- Database scaffolding + seed ------------------------------------------
write_schema() {
  local schema="$PAYWIFI_HOME/api/db/schema.sql"
  cat >"$schema" <<'SQL'
-- =====================================================================
--  PAYWIFI — SQLite schema  (v1)
-- =====================================================================
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS admin_users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin',     -- admin | viewer
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

CREATE TABLE IF NOT EXISTS voucher_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  notes           TEXT,
  created_by      INTEGER REFERENCES admin_users(id),
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT UNIQUE NOT NULL,
  batch_id          INTEGER REFERENCES voucher_batches(id),
  duration_minutes  INTEGER NOT NULL,                -- session length
  bandwidth_kbps    INTEGER NOT NULL,                -- speed cap, e.g. 5120 for 5 Mbps
  max_devices       INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'unused',  -- unused|active|expired|revoked
  created_at        INTEGER NOT NULL,
  first_used_at     INTEGER,
  expires_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_code   ON vouchers(code);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id),
  mac_address     TEXT NOT NULL,
  ip_address      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  ended_at        INTEGER,
  end_reason      TEXT,                              -- expired|logout|kicked|quota
  bytes_in        INTEGER NOT NULL DEFAULT 0,
  bytes_out       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_mac    ON sessions(mac_address);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(ended_at);

CREATE TABLE IF NOT EXISTS remembered_devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mac_address     TEXT UNIQUE NOT NULL,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id),
  valid_until     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id        INTEGER REFERENCES admin_users(id),
  action          TEXT NOT NULL,
  details         TEXT,
  ip_address      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voucher_plans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT UNIQUE NOT NULL,
  duration_minutes  INTEGER NOT NULL,
  bandwidth_kbps    INTEGER NOT NULL,
  max_devices       INTEGER NOT NULL DEFAULT 1,
  price             REAL    NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
SQL
  ok "Wrote schema → $schema"
}

seed_database() {
  title "Database initialisation"
  if [[ -f "$PAYWIFI_DB_FILE" ]]; then
    warn "Database already exists at $PAYWIFI_DB_FILE"
    if ! confirm "Re-initialise and re-seed?  (DESTRUCTIVE — existing data lost)" "N"; then
      ok "Keeping existing database."
      return
    fi
    local bak="${PAYWIFI_DB_FILE}.bak.$(date +%s)"
    cp -a "$PAYWIFI_DB_FILE" "$bak" && ok "Backup created: $bak"
    rm -f "$PAYWIFI_DB_FILE" "${PAYWIFI_DB_FILE}-wal" "${PAYWIFI_DB_FILE}-shm"
  fi

  write_schema
  sqlite3 "$PAYWIFI_DB_FILE" < "$PAYWIFI_HOME/api/db/schema.sql" \
    || die "Failed to apply schema."
  ok "Schema applied."

  # ----- Seed admin user -----
  local admin_user admin_pass admin_pass2 admin_hash now
  admin_user=$(prompt_default "Initial admin username" "admin")
  while true; do
    read -r -s -p "${C_YLW}?${C_RST} Initial admin password (min 8 chars): " admin_pass; echo
    if (( ${#admin_pass} >= 8 )); then break; fi
    warn "Too short."
  done
  read -r -s -p "${C_YLW}?${C_RST} Confirm password: " admin_pass2; echo
  [[ "$admin_pass" == "$admin_pass2" ]] || die "Passwords do not match."

  # bcrypt via node (already installed at this point)
  admin_hash=$(node -e "
    const c=require('child_process');
    try { require.resolve('bcryptjs'); }
    catch(e){ c.execSync('npm i -g bcryptjs', {stdio:'ignore'}); }
    const b=require(require('child_process').execSync('npm root -g').toString().trim()+'/bcryptjs');
    process.stdout.write(b.hashSync(process.argv[1], 10));
  " "$admin_pass") || die "Failed to hash admin password."

  now=$(date +%s)

  sqlite3 "$PAYWIFI_DB_FILE" <<SQL
INSERT INTO admin_users (username, password_hash, role, created_at)
VALUES ('${admin_user}', '${admin_hash}', 'admin', ${now});

-- Voucher plan presets
INSERT INTO voucher_plans (name, duration_minutes, bandwidth_kbps, max_devices, price, is_active, created_at) VALUES
  ('1 Hour @ 5Mbps',  60,    5120, 1, 20,  1, ${now}),
  ('1 Day @ 5Mbps',   1440,  5120, 1, 100, 1, ${now}),
  ('1 Week @ 5Mbps',  10080, 5120, 2, 500, 1, ${now}),
  ('3 Hours @ 10Mbps',180,  10240, 1, 50,  1, ${now});

-- System settings
INSERT INTO settings (key, value, updated_at) VALUES
  ('portal_name',         'PAYWIFI Hotspot',        ${now}),
  ('portal_brand_color',  '#0ea5e9',                ${now}),
  ('portal_terms_url',    '/terms.html',            ${now}),
  ('voucher_code_length', '8',                      ${now}),
  ('voucher_code_format', 'alnum_upper',            ${now}),
  ('mac_remember_hours',  '24',                     ${now}),
  ('idle_timeout_min',    '10',                     ${now});

-- Audit
INSERT INTO audit_log (admin_id, action, details, ip_address, created_at)
VALUES (1, 'bootstrap', 'Initial PAYWIFI bootstrap completed', '127.0.0.1', ${now});
SQL

  ok "Admin user '${admin_user}' created."
  ok "Seeded 4 voucher plans + default settings."

  # ----- Optional sample vouchers -----
  if confirm "Generate 10 sample vouchers for testing?"; then
    local i code
    for ((i=0; i<10; i++)); do
      code=$(tr -dc 'A-Z0-9' </dev/urandom | head -c 8)
      sqlite3 "$PAYWIFI_DB_FILE" <<SQL
INSERT INTO vouchers (code, duration_minutes, bandwidth_kbps, max_devices, status, created_at)
VALUES ('${code}', 60, 5120, 1, 'unused', ${now});
SQL
    done
    ok "Generated 10 test vouchers (1h @ 5Mbps each)."
    info "View them with:  sqlite3 ${PAYWIFI_DB_FILE} 'SELECT code FROM vouchers WHERE status=\"unused\";'"
  fi

  chown "$PAYWIFI_USER":"$PAYWIFI_USER" "$PAYWIFI_DB_FILE" 2>/dev/null || true
  chmod 660 "$PAYWIFI_DB_FILE"
}

# ----- Final summary ---------------------------------------------------------
final_summary() {
  hr
  echo "${C_GRN}${C_BLD} ${APP_NAME} bootstrap complete.${C_RST}"
  hr
  echo "Files & paths:"
  echo "   Config     : $PAYWIFI_CFG_DIR/config.json"
  echo "   Database   : $PAYWIFI_DB_FILE"
  echo "   Project    : $PAYWIFI_HOME"
  echo "   Logs       : $PAYWIFI_LOG_DIR"
  echo "   Service usr: $PAYWIFI_USER"
  echo
  echo "Quick checks:"
  echo "   sqlite3 $PAYWIFI_DB_FILE '.tables'"
  echo "   sqlite3 $PAYWIFI_DB_FILE 'SELECT * FROM voucher_plans;'"
  echo "   cat $PAYWIFI_CFG_DIR/config.json | jq ."
  echo
  echo "Next phase: network plumbing (interfaces / dnsmasq / nftables / ipset)."
  echo "Then:       API scaffolding (Node + Express)."
  hr
}

# ----- Main ------------------------------------------------------------------
main() {
  banner
  title "${APP_NAME} — Interactive Bootstrap"
  preflight_root
  preflight_os
  preflight_arch
  preflight_resources
  preflight_network_ifaces
  echo
  confirm "Proceed with ${APP_NAME} bootstrap?" || die "Aborted."

  check_packages
  install_packages
  check_nodejs
  check_kernel_modules

  create_user
  create_dirs
  write_config
  seed_database

  final_summary
}

main "$@"