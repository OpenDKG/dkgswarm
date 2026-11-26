# Licensing

## Decision

DKG Swarm is licensed under **GNU General Public License v3.0 or later** (`GPL-3.0-or-later`),
the same license as [`OpenDKG/Axiom`](https://github.com/OpenDKG/Axiom), under OpenDKG's licensing
decision of 2026-11-26.

- Full text: [`LICENSE`](../LICENSE)
- Copyright and grant: [`NOTICE`](../NOTICE)
- Authors and contributors: [`AUTHORS.md`](../AUTHORS.md)
- Third-party components: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)

## Earlier versions

From commit `cdc8032` (2026-11-08) until this change the project was released under the MIT
License, `Copyright (c) 2025 BRX`. Those versions stay available under MIT. Before that commit
no `LICENSE` file was tracked and `package.json` declared `ISC`. This change does not alter the
terms of anything already published.

## SPDX

Our own source files carry this identifier in a comment:

```text
SPDX-License-Identifier: GPL-3.0-or-later
```

It is on JavaScript, shell, CSS and HTML sources. `activity.mjs`, `server.mjs` and `test/activity.test.mjs`
carry `GPL-3.0-or-later AND ISC` because they contain the ISC contribution merged in pull request #1.
JSON, systemd unit files and media have no header.

When adding a source file, include the identifier. Do not remove existing copyright, SPDX or
third-party notice lines.

## Dependency compatibility

All packages in `package-lock.json` (92) and `collector/package-lock.json` (87) are MIT, ISC,
BSD-2-Clause or BSD-3-Clause, which are compatible with GPL-3.0-or-later. No incompatible
dependency was found. The ISC contribution from pull request #1 is also GPL-compatible.

Update `THIRD_PARTY_NOTICES.md` and this section whenever the locked graph changes. Apache-2.0
code is compatible with GPLv3 but **not** with GPLv2, so do not move to GPLv2 without a full
dependency review. Do not add a dependency whose license is not GPL-3.0-compatible.

## Distribution

When distributing the program, include `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md`, provide the
corresponding source, and state any modifications.

## Open: rights holders

Git authorship is not proof of copyright ownership, and the repository does not yet hold a
verified list of rights holders for the code in its history, including code from before the
MIT license. MIT and ISC allow redistribution inside a GPL work when their notices are kept,
which this change does. Completing that list is still open.

## Legal review

This document records an engineering and project decision, not legal advice. A legal and license
review is required before the next public release.
