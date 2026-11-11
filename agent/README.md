# Mimikyu Agent

The agent is a persistent localhost relay for the Mimikyu Caido plugin. It
keeps one CDP browser connection alive and creates background targets for
individual requests. It does not start or stop Chrome per request.

This implementation supports authenticated GET/HEAD navigation capture and a
first browser `fetch()` route for non-GET requests and `Sec-Fetch-Dest: empty`
requests. Form-specific behavior, resource requests, uploads, WebSockets, and
named egress are still follow-up work.

## Local development

```sh
npm install
CHROME_DEBUGGING_PORT=9222 MIMIKYU_TOKEN=dev-token npm start
```

The agent emits JSON lines containing `ready`, `browser`, and `request` events.
The token and CDP endpoint must remain local and must not be exposed to an
untrusted network. `MIMIKYU_MAX_TARGETS` controls concurrent background
targets and defaults to `8`; queued requests time out after ten seconds.

The optional `ON_START_HOOK_FILE_PATH`, `BEFORE_REQUEST_HOOK_FILE_PATH`, and
`AFTER_REQUEST_HOOK_FILE_PATH` variables point to local ES modules exporting
`async function hook(cdp, request, response, logger)`. Hooks execute inside the
request's existing background target; an after-hook failure does not discard a
captured response. The on-start hook runs before the agent reports the browser
as ready to request traffic.
