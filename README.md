# PAYWIFI

Self-contained captive-portal hotspot system: Debian 12 VM + Node.js + SQLite + nginx + nftables. Voucher auth, time/bandwidth quotas, MAC remembering, operator (cashier) console, web admin UI, and a Cloudflare tunnel for public access to the admin surface.

## Repo layout

| Path | What |
|---|---|
| `api/` | Node.js application — `src/` (Express routes, middleware, services) and `views/` (EJS admin + operator templates). |
| `portal-templates/` | Captive-portal frontends. Active template is `PAYWIFI_BASIC`; sources live under each template's `_src/` and concatenate via `build.sh`. |
| `scripts/sbin/` | Privileged helpers (`paywifi-auth`, `paywifi-shape`, `paywifi-watchdog`, `paywifi-cloudflared-apply`). Deploy to `/usr/local/sbin/`. |
| `scripts/phases/` | Six-phase install scripts. Run in numerical order on a fresh Debian 12 box. |
| `ops/systemd/` | Service units. |
| `ops/nginx/`, `ops/dnsmasq/`, `ops/sudoers/` | Reverse proxy, DHCP/DNS, sudoers entries. |
| `ops/config-examples/` | Sanitized templates for `config.json` (JWT secret) and `cloudflared.env` (Cloudflare tunnel token). |
| `CLAUDE.md` | Master operations runbook: phase-by-phase deploy, risk register, hardening checklist. |

## Fresh-install quick start

```bash
# On a clean Debian 12 VM, as root:
git clone git@github.com:jamesbajillo-gif/paywifisystem.git /root/paywifi-src
cd /root/paywifi-src/scripts/phases
sudo bash paywifi-bootstrap.sh
sudo bash paywifi-phase2-network.sh
sudo bash paywifi-phase3-captive.sh
sudo bash paywifi-phase4-api.sh
sudo bash paywifi-phase5-shaping.sh
sudo bash paywifi-phase6-admin.sh
```

Then visit `http://10.10.0.1/admin/cloudflare` to wire the tunnel, and `/admin/payments` to configure GCash/Cash. See `CLAUDE.md` for the full procedure.

## Secrets

Nothing sensitive is in this repo. The live gateway holds:

- `/etc/paywifi/config.json` — JWT signing secret + provider keys (generated on bootstrap; see `ops/config-examples/config.json.example`)
- `/etc/paywifi/cloudflared.env` — Cloudflare tunnel token (managed via `/admin/cloudflare`; see `ops/config-examples/cloudflared.env.example`)
- `/var/lib/paywifi/paywifi.db` — SQLite (admin password hashes, vouchers, sessions, audit log)
