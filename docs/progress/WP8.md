# WP8 progress
- started: reading 04 handbook + specs
- read: 04, 01 §4 (+contracts), F15, §12, §11.1 step-up, §11.9, §15.2, 03 R8. WP8 owns NO tables: everything via Services.
- PLAN server: src/http/{index,server,auth,security,util}.ts + routes/{me,home,approvals,grants,ledger,memory,tasks,connections,secretary,settings,billing,privacy,stepup}.ts
  auth: tma initData HMAC (signature kept), classes read 24h/write 1h/high 10m; user upserted; /api/export/download token-only.
  decisions: stepup enroll=high, verify=write, phrase=high(+pendingActionId for expected phrase); incognito POST /api/memory/incognito; pause via PATCH /api/settings {paused};
  memory consent PATCH /api/memory/consent; GET /api/memory/conversations; approvals editedFields passed as editedInput (CONTRACT REQUEST: WP4 revise needs full input).
- PLAN webapp: webapp/src/{main,App}.tsx styles.css lib/{tg,api,nav,i18n}.ts components/* screens/* (13 screens)
- PLAN tests: test/unit/http/{auth,security,routes}.test.ts, test/e2e/miniapp.e2e.test.ts (helpers in test/unit/http/world.ts)
- server files written: http/{index,server,auth,security,util}.ts + routes/* (13). next: typecheck, then tests
- test/unit/http/auth.test.ts green (9). next: test/unit/http/server.test.ts (CSP/static/healthz/SPA/export headers), routes.test.ts
- server.test.ts (9) + e2e miniapp (7) green. next: WEBAPP (lib/tg,api,nav,i18n; components; 13 screens; styles), then test/unit/http/routes.test.ts
- webapp design: screens home/approvals/approval/grant/ledger/memory/tasks/connections/secretary/settings/plan/privacy/tz (+export→privacy); secretary uses ?chat=; auto-save settings; i18n en+ru in lib/i18n.ts
- webapp lib/{tg,api,nav,i18n}.ts written. next: components, styles.css, screens, App/main, index.html, vite config
- webapp: components/*, lib/{me,actions}.ts, screens Home/Approvals/ApprovalDetail/GrantConfirm/Ledger written. next: Memory, Tasks, Connections, Secretary, Settings, Plan, Privacy, TzDetect, App, main, styles
- webapp screens all written + App/main/index/vite config. next: styles.css, typecheck webapp, build
- styles.css written; webapp typecheck clean; npm run build:webapp OK (dist/webapp). next: visual check via headless chrome (scratchpad mock server), routes.test.ts, full gate
- visual check done via headless chrome (en/ru, light/dark); polish fixes applied. next: test/unit/http/routes.test.ts, then full gate
- routes.test.ts green (14); http unit total 32. next: full gate
- FINAL GATE GREEN: tsc clean for src/http, test/unit/http, test/e2e/miniapp; webapp tsc clean; build:webapp OK; unit http 32/32; e2e miniapp 7/7 (full e2e 99/99). Remaining unit failures are foundation/testApp+freeze (stale WP0 expectations / other WPs), not WP8. WP8 COMPLETE.
