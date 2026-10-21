# HTTP routes (sinh tự động)

Nguồn: `apps/api/src/app.ts` (Fastify `printRoutes`). Route `/api/mock/*` chỉ được đăng ký ở mock mode; `/api/auth/*` (login demo) trả `CAPABILITY_UNSUPPORTED` ngoài mock mode.
Mọi route trừ `/api/health`, `/api/tools` và login demo yêu cầu `Authorization: Bearer <session>` của người dùng. Body được validate bằng JSON Schema (`additionalProperties: false`).

```text
├── /api/health (GET, HEAD)
├── /api/auth/demo-users (GET, HEAD)
├── /api/auth/mock-login (POST)
├── /api/audit (GET, HEAD)
├── /api/me (GET, HEAD)
├── /api/mock/analyst/draft (POST)
├── /api/mock/worker/drain (POST)
├── /api/mock/meta/fault (POST)
├── /api/status (GET, HEAD)
├── /api/dashboard (GET, HEAD)
├── /api/config (GET, HEAD)
│   ├── /draft (POST)
│   └── /confirm (POST)
├── /api/proposals (GET, HEAD, POST)
│   └── /:id (GET, HEAD)
│       ├── /revisions/:rev/decision (POST)
│       ├── /revisions/:rev/execute (POST)
│       ├── /revisions/:rev/cancel (POST)
│       └── /revisions/:rev/reconcile (POST)
├── /api/ops/health (GET, HEAD)
├── /api/ops/freeze (POST)
├── /api/ops/unfreeze (POST)
├── /api/ops/incidents (GET, HEAD, POST)
│   └── /:id/resolve (POST)
├── /api/tools (GET, HEAD)
└── * (OPTIONS)
```
