# Security policy

## Supported versions

vid2context is pre-1.0. Security fixes land on `main` and in the next release.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: [open a private security advisory](https://github.com/nirholas/vid2context/security/advisories/new). Only the maintainers can see it.

Please include:

- what an attacker can do and under which conditions
- steps or a proof of concept to reproduce it
- the commit or version you tested

You should get a first reply within a week. Once a fix is ready, we'll publish an advisory and credit you unless you prefer to stay anonymous.

Threat model and hardening guide: [docs/security/threat-model.md](docs/security/threat-model.md).

## Scope

In scope, for example:

- leaking API keys or tokens (in logs, errors, health output or stored results)
- server-side request forgery or path traversal through video inputs
- reading local files beyond the media file the user asked for
- code execution through crafted media, captions or provider responses

Documented behaviour, not vulnerabilities:

- Keyless lanes (OVH AI Endpoints, Pollinations) send audio or text to those third-party hosts without an account. Set `VID2CONTEXT_KEYLESS=0` or use `VID2CONTEXT_POLICY=local-only` to keep everything on your machine.
- Rate limits or blocking by upstream platforms.
