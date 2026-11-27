# Security Policy

## Reporting a vulnerability

Please do not open public issues for security problems.

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/smartloop-labs//security/advisories/new),
or email [support@smartloop.ai](mailto:support@smartloop.ai) with "SECURITY" in the subject.

We aim to acknowledge reports within 3 business days and will keep you informed
until the issue is resolved. Please give us reasonable time to ship a fix before
disclosing publicly.

## Secrets

Never commit credentials. Use `.env` files (git-ignored) or your platform's
secret manager; commit only `.env.example` with placeholder values.
