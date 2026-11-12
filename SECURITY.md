# Security policy

## Reporting

Please use GitHub's private vulnerability reporting feature when it is
available. Do not include live target credentials, session cookies, or
sensitive captured traffic in reports.

## Release boundary

The GitHub Actions build runs typecheck, lint, agent tests, package creation,
and package integrity checks. Docker images and dependencies should be pinned
before a production release.

## Runtime boundary

The agent binds to loopback or a private Docker network, requires a shared
token, strips internal routing headers, and refuses requests while the browser
is unavailable. CDP must never be exposed to an untrusted network. The Docker
development token must be replaced before non-local use.

Chrome profiles, cookies, hook files, Xpra, and agent tokens are sensitive.
Activity intentionally excludes request bodies, cookies, credentials, raw
headers, and tokens.

## Authorized use

This project is intended for authorized application-security assessment. Users are responsible for respecting target scope, rate limits, applicable law, and program rules.
