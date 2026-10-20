# Security

Report vulnerabilities privately to the project maintainers rather than opening a public issue. Do not include live credentials or sensitive customer content in a report.

OpenCMO binds to `127.0.0.1` by default. Browser-saved provider credentials are stored in the local SQLite database and masked by the settings API, but they are not encrypted at rest; protect the machine and database file accordingly. Publishing always requires an approved draft.

Website research blocks loopback, link-local, private, and private-DNS destinations, including redirects. `ALLOW_PRIVATE_FETCH=1` disables that protection and should only be used for intentionally trusted local sites. If exposing OpenCMO beyond the local machine, add authentication and a trusted reverse proxy; the built-in rate limiter is only a basic abuse control.
