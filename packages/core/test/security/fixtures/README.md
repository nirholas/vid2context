# Security test fixtures

| File | What | Source and date |
|---|---|---|
| `ssrf-payloads.txt` | SSRF bypass payloads that must be refused by the static URL policy | PayloadsAllTheThings, `Server Side Request Forgery/README.md` and `SSRF-Cloud-Instances.md` at commit `12e5d82ca65f2803f15e5ce74abc33674703dff2`, fetched 2026-11-14. Copied verbatim, grouped by technique. |
| `public-urls.txt` | Ordinary public video, podcast and CDN URLs that must be allowed | Written by hand on 2026-11-14 from hosts vid2context fetches. Only the URL shape matters; the tests never fetch them. |
| `dns-answers.json` | Real DNS answers for public names that point at private addresses (`*.nip.io`, `localtest.me`, `localh.st`, `spoofed.burpcollaborator.net`, a `1u.ms` rebinding name) and for three ordinary public hosts | Recorded 2026-11-14 with `node:dns/promises` `lookup(host, { all: true, verbatim: true })`, four lookups per name, unique answers kept. The names come from the same PayloadsAllTheThings page. |

Left out of `ssrf-payloads.txt`, on purpose:

- Names that only become private after DNS (`169.254.169.254.nip.io`, `localtest.me`, `1u.ms` rebinding): static checks cannot refuse them. They are covered by `dns-answers.json` and the resolver path of `checkUrl`.
- Open redirectors on public hosts (`307.r3dir.me`, `nicob.net/redir...`) and application proxies (`*.flaws.cloud/proxy/...`): the first hop is public, so they are covered by the redirect test in `fetch.test.ts`, where `safeFetch` refuses the private second hop.
- Payloads aimed at public hosts or placeholders (`http://1.1.1.1`, `http://google.com:80/`, the enclosed-alphanumeric `example.com`, `gopher://[host]:[port]/...`, documentation links): they are not internal targets.
