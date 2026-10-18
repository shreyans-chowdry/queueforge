# QueueForge operations console

Next.js dashboard for the QueueForge API. Requires Node.js 22.

```bash
npm ci
npm run dev
```

Open http://localhost:3000 with the API running on port 8000. For another API host,
set these values in `.env.local` **before building**:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000
```

The console shows the latest 150 jobs, polls every 5 seconds, and coalesces WebSocket
notifications into API snapshots. It reconciles after reconnecting and exposes HTTP
failures inline. Search by job ID, worker, status or payload; click an ID to inspect
errors and lifecycle timestamps. Times are displayed in IST.

Run `npm run lint`, `npx tsc --noEmit`, and `npm run build` to verify changes.
After building, install Chromium with `npx playwright install chromium` and run
`npm run test:e2e`. Tests start the production server on port 3100 and mock the API.

The production dependency audit is clean. See the root README for the remaining
upstream lint-tool advisories and backend integration test setup.
