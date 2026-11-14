# vid2context eval: citations (2026-11-14)

- Dataset: `packages/evals/datasets/citations.json`, 8 of 8 items evaluated
- Rungs: `ask`, `brief`
- Environment: Node 24.22.2 on linux-x64, policy `free`, keyless on
- Run: 2026-11-14T17:38:59.382Z to 2026-11-14T17:43:33.146Z

## Summary

| Producer | Questions | OK | Citation accuracy | Expected place hit | Self-rejected | p50 latency | p90 latency |
|---|---|---|---|---|---|---|---|
| ask | 8 | 8 | 100.0% | 100.0% | 0.0% | 2594 ms | 4524 ms |
| brief | 8 | 8 | 96.2% | 87.5% | 5.5% | 23.5 s | 45.5 s |

Citation accuracy: citations whose quote occurs in the transcript within 30 s of their time, over all citations returned. Expected place hit: questions where at least one citation lands within 30 s of a labeled answer. Self-rejected: citations the producer dropped itself (unverified brief claims, unknown [n] refs).

## Items

| Question | Producer | Outcome | Verified / cited | Hit | Latency |
|---|---|---|---|---|---|
| reliable-engine | ask | ok | 1 / 1 | yes | 2254 ms |
| g55-horsepower | ask | ok | 1 / 1 | yes | 1818 ms |
| g55-oil | ask | ok | 1 / 1 | yes | 1832 ms |
| m278-years | ask | ok | 3 / 3 | yes | 4889 ms |
| daily-driver | ask | ok | 1 / 1 | yes | 2304 ms |
| why-na-offroad | ask | ok | 2 / 2 | yes | 2904 ms |
| appreciate | ask | ok | 1 / 1 | yes | 2884 ms |
| add-tech | ask | ok | 3 / 3 | yes | 4367 ms |
| reliable-engine | brief | ok | 5 / 5 | yes | 22.1 s |
| g55-horsepower | brief | ok | 4 / 4 | yes | 20.7 s |
| g55-oil | brief | ok | 3 / 4 | yes | 20.1 s |
| m278-years | brief | ok | 6 / 6 | yes | 29.1 s |
| daily-driver | brief | ok | 4 / 4 | yes | 22.7 s |
| why-na-offroad | brief | ok | 7 / 7 | yes | 24.3 s |
| appreciate | brief | ok | 7 / 7 | yes | 30.5 s |
| add-tech | brief | ok | 14 / 15 | no | 80.3 s |

## Notes

- LLM rungs that answered: llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast.
