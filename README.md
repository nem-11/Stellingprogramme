# 119HS Programme Management System v2

## Setup

1. Open this folder in Cursor
2. Open terminal (View > Terminal)
3. Run these commands:

```
npm install
cd client
npm install
cd ..
node server/seed.js
npm run dev
```

4. Open http://localhost:3000

## Logins

| User | Username | Password | Role |
|------|----------|----------|------|
| Nem | admin | 119hs | Admin |
| Site Team | site | site123 | View only (Dash, Ahead, Plan, Zones, Modules) |
| DBs | DBs | ground1 | GW Viewer |
| IKEW | IKEW | Ikew1 | INT Viewer |
| Board | board | board119 | Viewer |
| 119HS (shared) | 119hs | site119 | Programme view only |

The **site** login is view-only: Dash, Ahead, Plan, Zones, and Modules — no Update ticking, Programme editor, or schedule shifting. The **119hs** login is Plan view only for handing out to trades.

## Features

- **Dashboard** — Stats, milestones, sequences
- **Update** — Mobile tick-off with progress
- **Look-Ahead** — 3-week forward view
- **Plan** — Upload drawings, draw zones, auto-colour by activity
- **Programme Editor** — Add/remove activities per day
- **Templates** — Build sequence once, apply to any zone with start date (auto-repeat floors)
