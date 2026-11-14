import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../checks/lib.mjs';
import { cutChangelog, MANIFESTS, nextVersion, setVersion } from '../release/version.mjs';

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

  it('cuts the real changelog: notes move under the version, links point at the tags', () => {
    const out = cutChangelog(changelog, { version: '0.2.0', previous: null, date: '2026-11-20' });
    expect(out).toMatch(/## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-11-20\n\n### Added/);
    expect(out).toContain('[Unreleased]: https://github.com/nirholas/vid2context/compare/v0.2.0...HEAD');
    expect(out).toContain('[0.2.0]: https://github.com/nirholas/vid2context/releases/tag/v0.2.0');
    expect(out).not.toContain('commits/main');
    expect(() => cutChangelog(out, { version: '0.2.1', previous: '0.2.0', date: '2026-11-21' })).toThrow(/empty/);

    const next = out.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- A fix.\n');
    const second = cutChangelog(next, { version: '0.2.1', previous: '0.2.0', date: '2026-11-21' });
    expect(second).toContain('[0.2.1]: https://github.com/nirholas/vid2context/compare/v0.2.0...v0.2.1');
    expect(second).toContain('[0.2.0]: https://github.com/nirholas/vid2context/releases/tag/v0.2.0');
    expect(second.indexOf('## [0.2.1]')).toBeLessThan(second.indexOf('## [0.2.0]'));
  });
});
