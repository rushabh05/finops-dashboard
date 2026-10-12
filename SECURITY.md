# Security policy

## Reporting a vulnerability

Please report security problems **privately**: use GitHub's *Report a vulnerability* button on this repository's **Security** tab
(private vulnerability reporting). Do not open a public issue or pull request for a vulnerability. I will acknowledge a report within a few days
and agree a fix and disclosure timeline with you. This is a personal open-source project, maintained on a best-effort basis.

## What the project is, and is not

A local-first dashboard. By default it binds to `127.0.0.1` with **no authentication**, which is appropriate for one person on one machine.
If you expose it beyond loopback you need `AUTH_TOKEN` (the server refuses to listen on another address without one), HTTPS in front of it, and `ALLOWED_ORIGINS` /
`ALLOWED_HOSTS` for the names you serve. Authentication is **one shared secret**: no users, roles, rate limiting or lockout. See *Security* in the README for the full list
of measures (parameterized SQL, parameter allowlists, body caps, Origin and Host checks, CSP, constant-time token comparison, CSRF protection for the session cookie) and the caveats.

## In scope

* Authentication or Origin/Host bypasses; reading or writing data without the token when `AUTH_TOKEN` is set.
* SQL injection, XSS, path traversal, request smuggling or resource-exhaustion bugs reachable through the HTTP, SSE or WebSocket interfaces.
* The importers leaking data they promise not to keep (message text from Claude Code transcripts; full file paths).
* Anything that lets untrusted CSV, JSONL or database content execute code or escape the intended directories.

## Out of scope

* Running it on a network without `AUTH_TOKEN` and `ALLOW_INSECURE=1` (an explicit opt-out), or without HTTPS, and then being able to read traffic.
* Findings that need an attacker who already controls the machine or the data directory.
* The accuracy of prices or of the anomaly detector (open a normal issue).
* Denial of service by a client that is authenticated, or by the 64-channel limit being reached.

## Supported versions

Only the latest release on the `main` branch.
