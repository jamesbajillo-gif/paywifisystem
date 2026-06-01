# PAYWIFI_BASIC — Dumb Captive Portal

A static frontend imported from `templates/paywifi-theme-basic` and rewired to talk only to the existing PAYWIFI backend on this gateway. No Supabase, no Xendit SDK on the client, no separate Node service — nginx serves the static files; every API call hits `/api/*` on the same origin.

## What lives here

```
index.html      Single-page portal (home / plans / checkout / result / connected views)
app.js          Vanilla JS — wires UI events to /api/* endpoints
app.css         Hand-extracted design tokens from the original Vite/Tailwind theme
probes/         OS captive-portal probe responses (nginx normally proxies these to the API)
_source/        The original React source as a tarball — kept for future full conversion
README.md       This file
```

## Backend mapping

See `PAYWIFI_BASIC-INTEGRATION-PLAN.md` in the workspace root for the full mapping between the original template's `portal-api.ts` functions and the existing PAYWIFI endpoints.

Quick reference:

| UI action                | HTTP                                        |
|--------------------------|---------------------------------------------|
| Load branding / config   | `GET  /api/portal/config`                   |
| List plans               | `GET  /api/portal/plans`                    |
| List payment methods     | `GET  /api/portal/payment-options`          |
| Submit voucher           | `POST /api/auth/voucher`                    |
| Start payment            | `POST /api/portal/payment/create`           |
| Poll payment status      | `GET  /api/portal/payment/status/:id`       |
| Cancel pending payment   | `POST /api/portal/payment/cancel`           |
| Restore active session   | `GET  /api/session/status`                  |
| Disconnect               | `POST /api/session/logout`                  |

## Switching to/from this template

```bash
sudo paywifi-template switch PAYWIFI_BASIC   # activate
sudo paywifi-template switch PAYWIFI         # roll back
sudo paywifi-template list                   # see all
```

## Future: rebuild with the full React app

Unpack `_source/paywifi-theme-basic.tgz` and follow the integration plan to:
1. Strip Supabase + Xendit server-side code (`*.server.ts`, `api/db.functions.ts`, `api/xendit-webhook.server.ts`).
2. Rewrite `src/lib/portal-api.ts` to call `/api/*` on the gateway via `fetch`.
3. Build as a SPA (Vite, SSR disabled) and replace the static files in this directory with the build output.
