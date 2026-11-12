# Mimikyu Repository Guidelines

## Handoff state

Read [`IMPLEMENTATION_STATE.md`](IMPLEMENTATION_STATE.md) before changing the
architecture. Update it after meaningful implementation work so another agent
can continue without reconstructing decisions from chat history.

## Architecture constraints

- Keep the browser process persistent; never launch or close it per request.
- Use one background/hidden CDP target per concurrent request.
- Keep CDP and the agent relay on loopback or a private Docker network.
- Preserve fail-closed behavior when the agent or browser is unavailable.
- Do not put request bodies, cookies, raw headers, credentials, or tokens in
  Activity or normal logs.
- Treat Docker-managed Chrome and external-CDP Chrome as providers behind the
  same agent interface.

## Validation

From the repository root, run:

```sh
pnpm -r typecheck
pnpm lint
pnpm build
docker compose -f docker-compose.mimikyu.yml config --quiet
```

The agent has its own `npm ci` and syntax checks under `agent/`.
