import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../checks/lib.mjs';
import { cutChangelog, MANIFESTS, nextVersion, setCitation, setVersion } from '../release/version.mjs';

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

describe('version', () => {
  it('bumps semver parts and accepts an explicit newer version', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.9.3', 'major')).toBe('1.0.0');
    expect(nextVersion('0.1.0', '0.3.0')).toBe('0.3.0');
    expect(() => nextVersion('0.2.0', '0.1.5')).toThrow(/not newer/);
    expect(() => nextVersion('0.1.0', 'next')).toThrow(/patch, minor, major/);
  });

  it('changes only the version line of the real manifests', () => {
    for (const path of MANIFESTS) {
      const text = readFileSync(join(ROOT, path), 'utf8');
      const out = setVersion(text, '9.8.7');
      expect(JSON.parse(out).version).toBe('9.8.7');
      expect(out.split('\n').filter((l, i) => l !== text.split('\n')[i])).toHaveLength(1);
    }
  });

  it('moves the real CITATION.cff to the release: version and date-released only', () => {
    const cff = readFileSync(join(ROOT, 'CITATION.cff'), 'utf8');
    const out = setCitation(cff, '9.0.0', '2026-11-20');
    expect(out).toMatch(/^version: 9\.0\.0$/m);
    expect(out).toMatch(/^date-released: 2026-11-20$/m);
    const changed = out.split('\n').filter((l) => !cff.split('\n').includes(l));
    expect(changed.sort()).toEqual(['date-released: 2026-11-20', 'version: 9.0.0']);
    // A second release replaces the date instead of adding another line.
    const again = setCitation(out, '9.0.1', '2026-11-21');
    expect(again.match(/^date-released:/gm)).toHaveLength(1);
    expect(again).toMatch(/^date-released: 2026-11-21$/m);
  });

  it('cuts the real changelog: notes move under the version, links point at the tags', () => {
    // Right after a release the real Unreleased section is empty (and cutting it must refuse), so the test gives it
    // notes and cuts versions newer than any released one: it holds at every point in the release cycle.
    expect(() =>
      cutChangelog(changelog.replace(/## \[Unreleased\]\n[\s\S]*?(?=## \[)/, '## [Unreleased]\n\n'), {
        version: '9.0.0',
        previous: null,
        date: '2026-11-20',
      }),
    ).toThrow(/empty/);

    const withNotes = changelog.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n- A feature.\n');
    const out = cutChangelog(withNotes, { version: '9.0.0', previous: null, date: '2026-11-20' });
    expect(out).toMatch(/## \[Unreleased\]\n\n## \[9\.0\.0\] - 2026-11-20\n\n### Added\n\n- A feature\./);
    expect(out).toContain('[Unreleased]: https://github.com/nirholas/vid2context/compare/v9.0.0...HEAD');
    expect(out).toContain('[9.0.0]: https://github.com/nirholas/vid2context/releases/tag/v9.0.0');
    expect(out).not.toContain('commits/main');
    expect(() => cutChangelog(out, { version: '9.0.1', previous: '9.0.0', date: '2026-11-21' })).toThrow(/empty/);

    const next = out.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- A fix.\n');
    const second = cutChangelog(next, { version: '9.0.1', previous: '9.0.0', date: '2026-11-21' });
    expect(second).toContain('[9.0.1]: https://github.com/nirholas/vid2context/compare/v9.0.0...v9.0.1');
    expect(second).toContain('[9.0.0]: https://github.com/nirholas/vid2context/releases/tag/v9.0.0');
    expect(second.indexOf('## [9.0.1]')).toBeLessThan(second.indexOf('## [9.0.0]'));
  });
});
