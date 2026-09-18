# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/antasphere/slideless/security/advisories/new).
Never open a public issue or pull request for a security problem: that
discloses it before a fix exists. Include reproduction steps and your
assessment of impact.

## Supported versions

The latest release is the only supported version: the head of the `prod`
branch and the newest `ghcr.io/antasphere/slideless` tag. Self-hosted
instances upgrade with `./update.sh`
([docs/self-hosting/upgrade.md](docs/self-hosting/upgrade.md)).

## Posture

The enforced security posture (headers, rate limits, the fail-closed scope
allowlist for machine principals, the user-content rule) is documented in
[docs/security/security.md](docs/security/security.md).
