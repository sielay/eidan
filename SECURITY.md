# Security Policy

## Supported Versions

eidan is pre-1.0 and under active development. Security fixes are
applied to the latest `main` only. There are no long-term support
branches yet; once we cut tagged releases this policy will list the
supported version ranges.

| Version       | Supported          |
| ------------- | ------------------ |
| `main` (HEAD) | :white_check_mark: |
| < 0.1         | :x:                |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report privately through GitHub's
[Private Vulnerability Reporting](https://github.com/sielay/eidan/security/advisories/new)
(the "Report a vulnerability" button under the repo's **Security** tab).

If you cannot use GitHub, email **security@eidan.dev**with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version / commit, and
- any suggested remediation.

### What to expect

- **Acknowledgement** within 3 business days.
- **Triage & assessment** within 10 business days, with a severity
  rating and whether we accept the report.
- **Status updates** at least every 14 days until resolution.
- On a fix, we'll coordinate disclosure timing with you and credit
  you in the advisory unless you prefer to remain anonymous.

Please give us a reasonable window to ship a fix before any public
disclosure (we aim for 90 days or sooner for high-severity issues).
