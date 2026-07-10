# Security policy

## Reporting a vulnerability

Report vulnerabilities privately to **security@codika.io**. Never open a
public issue or PR for a security problem — that discloses it before a fix
exists. Include reproduction steps and your assessment of impact; you will
get an acknowledgement and a remediation timeline.

## Supported versions

The latest `main` is the only supported version. Instantiated products are
responsible for pulling fixes into their own trees.

## Posture

The enforced security posture (headers, rate limits, the fail-closed scope
allowlist for machine principals, the user-content rule) is documented in
[docs/security.md](docs/security.md).
