# Mimikyu Implementation State

**Last updated:** 2026-11-12  
**Owner:** OpenCode session  
**Purpose:** Handoff state for future agents continuing the implementation.

## Product decision

Mimikyu is a Caido plugin that routes selected Caido traffic through a
persistent browser execution engine. The browser must not be started or
stopped for each request. Each request receives a background CDP target that
is closed after completion, while the browser process, profile, and CDP
connection remain alive.

The initial browser mode is a Docker-managed, persistent Chrome profile. The
architecture must later support an external local Chrome/Chromium/Edge/Brave
CDP endpoint through the same `BrowserProvider` abstraction.

## Repositories used as sources

- `caido-impersonate-tls`: Caido plugin structure, fail-closed routing,
  lifecycle, token authentication, Activity, settings, egress isolation, and
  packaging patterns.
- `thermoptic`: CDP request classification, browser routes, response capture,
  cookies, hooks, health checks, and browser-container setup.

## Completed in this handoff

- Created a new working tree at `mimikyu/` by copying the Caido plugin base
  without Git metadata.
- Added `agent/`, a persistent Node.js browser agent.
- Added `agent/cdptransport.mjs`, adapted from thermoptic's bounded CDP
  transport connector.
- Added `agent/browser-manager.mjs` with one persistent browser connection and
  background/hidden target creation.
- Added `agent/browser-executor.mjs` with initial GET/HEAD navigation capture
  through CDP Fetch response interception.
- Added `agent/relay.mjs` with loopback HTTP relay, constant-time token
  comparison, request metadata validation, body limits, and JSON event hooks.
- Added `agent/server.mjs` with readiness, browser-state, request, and graceful
  shutdown events.
- Added `agent/Dockerfile` and `docker-compose.mimikyu.yml` for a persistent
  Chrome container with an Xpra UI at `127.0.0.1:14111`.
- Added `agent/README.md` and this handoff state.
- Renamed the plugin identity to `mimikyu` and added the first browser-oriented
  settings/status UI.
- Replaced the copied backend transport adapter with `AgentService`, which can
  connect to an externally running agent or spawn the packaged agent in local
  development.
- Replaced the native rejection helper with a loopback HTTP `503` rejector.
- Connected the Caido upstream hook to the authenticated Mimikyu relay and
  preserved Activity completion and interruption handling.
- Added a Docker-managed Chrome/agent Compose setup with a persistent profile.
- Verified `pnpm -r typecheck`, `pnpm lint`, and `pnpm build` successfully.
- Extended the relay to forward method, headers, and body metadata.
- Added request classification and a first persistent-target browser `fetch()`
  route, including binary request bodies and request-cookie injection.
- Added synthetic CORS preflight handling for generated fetch requests and
  coverage for navigation/fetch classification and document generation.
- Added initial resource routes for audio, fonts, frames, images, manifests,
  scripts, styles, tracks, video, and workers using injected browser HTML.
- Added an initial URL-encoded HTML form route with generated hidden inputs;
  multipart forms remain explicitly unsupported.
- Removed the copied named-egress API/store from the MVP and made requests
  carrying `X-Morpheus-Egress` fail closed until browser egress isolation is
  implemented.
- Added a persistent browser target pool boundary with a default maximum of
  eight concurrent targets and a ten-second queue timeout.
- Added automatic CDP reconnect attempts every five seconds after browser
  disconnects, while keeping requests fail closed during the outage.
- Added Compose healthchecks for Chrome CDP readiness and the agent relay, so
  the agent waits for a usable browser instead of only waiting for container
  startup.
- Added optional before-request and after-request hook execution inside the
  already-acquired background target, with after-hook failures isolated from
  the captured response.
- Added an optional on-start hook with a readiness barrier: requests return
  `503` until browser connection and startup hook preparation complete.
- Added a local E2E origin service and `tests/e2e/agent-smoke.mjs` covering
  navigation, browser fetch/POST, resource, URL-encoded form, and cookie
  forwarding through the Dockerized browser.
- Built the Chrome image successfully and passed the real Docker E2E smoke
  test with `docker compose -p mimikyu-poc`.
- Passed the full Caido integration smoke: package installation, Upstream rule
  creation, external agent configuration, proxy request, and Activity entry.
- Added a deterministic protocol origin with streaming, multipart upload, and
  WebSocket echo endpoints; its direct protocol smoke test passes.
- Fixed the CDP response-stage guard for `null` status codes; the real Caido
  integration and agent smoke tests pass again after rebuilding the agent.
- Added body-read fallbacks for no-body responses and Network-domain capture;
  both the agent and full Caido integration smoke tests pass after the fix.
- Added Caido `onInterceptResponse` Activity completion for external agents;
  the Caido integration smoke now requires `succeeded` Activity state.
- Removed the development token from new settings defaults; Docker-managed mode
  now refuses to start without an explicitly configured agent token.
- Removed compressed-response encoding headers when returning CDP-decoded
  bodies, fixing real compressed HTML/font responses in Caido's browser path.
- Operator manually validated `rentcars.com` through the Caido browser path;
  the page rendered with its protection layer, CSS, WOFF fonts, JavaScript,
  and Next.js-associated requests working. This is an operator report, not a
  formal browser-fingerprint parity certification.
- Operator validated direct proxy traffic with curl through Caido for both
  navigation and browser `fetch()`/POST. The origin received a Chrome 157
  user agent and returned the expected HTML/JSON responses.
- Added the official `caido-dev watch` workflow; the local hot-reload server is
  running at `http://localhost:3000` for the installed Caido DevTools plugin.
- Fixed direct-egress Docker configuration, a relay header shadowing bug, and
  improved CDP target fallback and response fulfillment.
- Verified the agent test suite now passes five routing/generation tests.
- Added agent routing/generator tests; `pnpm test:agent` passes.

## Current limitations

1. The agent currently supports navigation, a first browser `fetch()` route,
   initial resource routes, and URL-encoded forms. Multipart uploads, file
   uploads, WebSockets, and named egress are not integrated yet.
2. The agent currently uses direct `Page.navigate` for navigation and to host
   the generated fetch document. The thermoptic bookmark-driven navigation
   behavior must be ported before claiming browser-parity compatibility.
3. The Docker development token is intentionally a placeholder and must not be
   used in a released package; production secret handoff remains.
4. No agent-specific CI job has been added yet; the agent now has a production
   `package-lock.json` and its Docker image builds successfully.
5. Production agent packaging and removal of the final legacy profile metadata
   are still pending.
6. The Caido POC smoke test exercises package installation, Upstream rule
   routing, the external Docker agent, and a real proxy response.
7. Activity completion is bridged through Caido's `onInterceptResponse` event;
   failure-only paths without a response still need a dedicated error event.

## Recommended next steps

### Phase 1 — Rename and backend adapter

1. ~~Update `caido.config.ts`, root `package.json`, manifests, README, and
   frontend labels from Impersonate TLS to Mimikyu.~~ Done.
2. ~~Replace the copied `TransportService` with `AgentService`.~~ Done.
3. Start the packaged agent through the same serialized lifecycle used by the
   original plugin, with SHA-256 verification and owner heartbeat.
4. ~~Parse the agent's `ready`, `browser`, and `request` JSON events.~~ Done.
5. ~~Change `packages/backend/src/upstream.ts` to send Mimikyu metadata and
   route to the agent relay.~~ Done.
6. ~~Keep the reject-only path so Caido cannot fall back to direct transport.~~ Done.

### Phase 2 — Shared API and UI

1. Replace TLS profile settings with browser mode, CDP endpoint, target limit,
   browser status, and persistent-profile settings.
2. Retain Activity privacy rules and add browser/session state.
3. Add a Docker setup/help panel and external-CDP configuration.
4. Remove identity-mismatch warnings tied to TLS profiles.

### Phase 3 — Thermoptic routes

1. ~~Port request classification from `thermoptic/requestengine.js`.~~ Initial
   classifier done.
2. ~~Port `fetchgen.js` and the fetch/form/resource routes.~~ Initial fetch,
   form, resource, and generator routes done.
3. ~~Adapt the existing route functions to receive an acquired persistent
   target instead of opening and closing a browser connection per request.~~
   Done for current routes.
4. Add cookie policy: shared persistent session versus isolated request mode.
5. ~~Port hooks only after the request lifecycle is isolated and bounded.~~
   Before/after/on-start hooks done.

### Phase 4 — Production hardening

1. Add a real secret handoff instead of an environment token.
2. Add agent packaging for the supported Caido platform.
3. ~~Add browser health/reconnect and target-pool limits.~~ Initial reconnect,
   healthchecks, and target-pool limits done.
4. Add authenticated upstream proxy routing.
5. Add integration tests against a local origin and a real Chrome container.
6. ~~Remove the legacy Go transport tree and copied legacy tests/docs.~~ Done.

## Validation commands

From `mimikyu/`:

```sh
docker compose -f docker-compose.mimikyu.yml up --build
curl http://127.0.0.1:38427/health
pnpm typecheck
pnpm lint
```

The Docker health request should report `browser: "connected"` after the
Chrome container exposes CDP. The full Caido acceptance smoke is available via
`pnpm test:e2e:caido` and requires the Caido Compose override.

The completed POC validation is:

```sh
docker compose -p mimikyu-poc -f docker-compose.mimikyu.yml up -d
pnpm test:e2e:agent
```

## Handoff rules

- Read this file before changing architecture.
- Preserve the persistent-browser decision.
- Do not launch or close the browser per request.
- Do not expose CDP outside the local machine or private Docker network.
- Keep request bodies, cookies, headers, and tokens out of Activity.
- Update this file after each meaningful architectural or implementation
  change.
