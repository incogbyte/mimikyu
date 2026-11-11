# Mimikyu — Implementation Specification

**Status:** MVP in progress  
**Version:** `0.1.0`

## Goal

Mimikyu is a Caido plugin that executes selected requests through a persistent
browser session. It combines the Caido plugin lifecycle and fail-closed relay
patterns from `caido-impersonate-tls` with the browser/CDP execution model from
`thermoptic`.

The browser must be started once and kept alive. Mimikyu must never launch or
close the complete browser for every request.

## Architecture

```text
Caido upstream hook
        │ authenticated localhost relay
        ▼
Mimikyu agent
        │ persistent CDP connection
        ▼
Chrome/Chromium browser
        │ background target per request
        ▼
Target service
```

### Components

| Component | Responsibility |
| --- | --- |
| `packages/backend` | Caido API, upstream routing, settings, Activity, agent lifecycle, and fail-closed rejection. |
| `packages/frontend` | Browser mode, endpoint, lifecycle, and Activity UI. |
| `packages/shared` | Settings, status, Activity, API, and event types. |
| `agent` | Persistent CDP connection, target pool boundary, relay authentication, and response capture. |
| `docker/chrome` | Persistent Chrome profile, Xpra UI, CDP endpoint, GPU/recovery options. |

## Browser lifecycle

1. Start or connect to the browser once.
2. Keep the CDP browser connection alive.
3. Create a background/hidden target for each request.
4. Execute the browser operation in that target.
5. Capture the response.
6. Close only the target and its CDP session.
7. Reconnect if the browser disconnects.

The default Docker mode uses a persistent named volume. An external-CDP mode
will support a user-selected Chrome/Chromium/Edge/Brave instance later.

## Relay contract

The Caido backend connects to the agent over loopback and sends these internal
headers:

```text
X-Mimikyu-Token
X-Mimikyu-Scheme
X-Mimikyu-Host
X-Mimikyu-Port
X-Mimikyu-Trace
X-Mimikyu-Max-Body-Bytes
```

The agent must authenticate and validate the metadata, remove internal data
from the browser-facing request, execute the browser route, and return the
captured response. Invalid or unavailable routing must fail closed with an
error response rather than falling back to Caido's direct transport.

## Settings

```ts
type Settings = {
  enabled: boolean;
  autoStart: boolean;
  browserMode: "docker-managed" | "external-cdp";
  agentHost: string;
  agentPort: number;
  cdpHost: string;
  cdpPort: number;
  maximumUploadMiB: number;
};
```

The browser profile is clean and persistent, not recreated for every request.
The user can use the Docker Xpra UI to perform an authorized login and then
reuse that session from Caido.

## MVP scope

Implemented:

- Persistent agent and CDP browser connection.
- Background/hidden target acquisition and cleanup.
- GET/HEAD navigation capture.
- Initial browser `fetch()` execution for POST and `Sec-Fetch-Dest: empty` requests.
- Initial resource execution through injected browser HTML.
- Initial URL-encoded form submission support.
- Local relay token authentication.
- Caido settings, Activity, and fail-closed rejection path.
- Docker Chrome profile and Xpra development setup.

Not yet implemented:

- Multipart/file uploads and WebSockets.
- Named egress routing through Chrome.
- Production agent bundling and checksum packaging.
- External-CDP UI validation and browser reconnect policy.
