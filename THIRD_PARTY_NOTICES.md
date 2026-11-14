# Third-party notices

vid2context is licensed under Apache-2.0 (see LICENSE). It includes or adapts code from the projects below, under their own permissive licenses. Dependencies installed from npm carry their own license files in `node_modules` and are not listed here; this file lists code copied or ported into this repository.

Add an entry when you copy or port code: the project, its URL, its license, the copyright line, and the files in this repo that contain the copied or adapted code. For Apache-2.0 projects, include their NOTICE text if they have one. See `docs/prior-art.md` for which licenses allow copying.

## Entries

### SponsorBlock segment data (data, not code)

- Source: https://sponsor.ajay.app, read at run time through its public API (`/api/skipSegments/<hash prefix>`). No SponsorBlock code is copied; its server is AGPL-3.0 and is not used.
- License: the database is CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/), per the SponsorBlock server README.
- Attribution shown with every result that uses it: "Segment data: SponsorBlock (sponsor.ajay.app), CC BY-NC-SA 4.0".
- Non-commercial: a paid hosted plan must not depend on this data. `VID2CONTEXT_SPONSORBLOCK=0` turns it off.
- Files: `packages/skips/src/` (lookups), `packages/skips/test/fixtures/skipSegments-*.json` (recorded API responses).
