import { readFileSync } from 'node:fs';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import type { Hardware } from '../src/hardware.ts';
import { latestRelease, nightlyTagOf, pickAsset, planInstall } from '../src/install.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const latest = JSON.parse(fixture('gh-release-latest.json'));
const nightly = JSON.parse(fixture('gh-release-b5454.json'));
const vm = JSON.parse(fixture('hardware-gcp-vm.json')) as Hardware;
const noTools = { cmake: false, nvcc: false, glslc: false };

describe('releases (recorded GitHub API, 2026-11-14)', () => {
  it('finds the nightly twin of a version release', () => {
    expect(latest.assets).toHaveLength(0);
    expect(nightlyTagOf(latest.body)).toBe('b5454');
  });

  it('follows the version release to its nightly assets', async () => {
    const fetch = replayFetch([
      { url: 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', response: { body: JSON.stringify(latest) } },
      {
        url: 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5454',
        response: { body: JSON.stringify(nightly) },
      },
    ]);
    const rel = await latestRelease(testContext({ fetch }));
    expect(rel.tag).toBe('v1.9.5');
    expect(rel.commit).toBe('d1be6fde11ac6e0407606b4e42fe72d34add8037');
    expect(rel.assetsTag).toBe('b5454');
    expect(fetch.calls[0]?.headers['user-agent']).toBe('vid2context');
  });
});

describe('planInstall', () => {
  it('uses the prebuilt Linux x64 CPU archive on this VM, with a digest', () => {
    const plan = planInstall('linux', 'x64', vm, noTools);
    expect(plan.kind).toBe('prebuilt');
    if (plan.kind !== 'prebuilt') return;
    const asset = pickAsset(nightly.assets, plan.asset);
    expect(asset?.name).toBe('whisper-bin-ubuntu-x64.tar.gz');
    expect(asset?.digest).toBe('sha256:a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c');
  });

  it('builds with CUDA when an NVIDIA GPU and nvcc are present', () => {
    const gpu: Hardware = { ...vm, gpu: { vendor: 'nvidia', vramMb: 8192, cuda: true } };
    expect(planInstall('linux', 'x64', gpu, { ...noTools, nvcc: true })).toMatchObject({
      kind: 'source',
      backend: 'cuda',
      flags: ['-DGGML_CUDA=1'],
    });
    const noNvcc = planInstall('linux', 'x64', gpu, noTools);
    expect(noNvcc).toMatchObject({ kind: 'prebuilt', backend: 'cpu' });
    expect(noNvcc.notes[0]).toMatch(/nvcc/);
    expect(planInstall('linux', 'x64', gpu, { ...noTools, nvcc: true }, { forceCpu: true })).toMatchObject({
      kind: 'prebuilt',
      backend: 'cpu',
    });
  });

  it('builds with Metal on Apple Silicon and picks the Windows CUDA zip', () => {
    expect(planInstall('darwin', 'arm64', { ...vm, gpu: { vendor: 'apple', metal: true } }, noTools)).toMatchObject({
      kind: 'source',
      backend: 'metal',
      flags: [],
    });
    expect(planInstall('darwin', 'arm64', vm, noTools, { forceCpu: true })).toMatchObject({
      backend: 'cpu',
      flags: ['-DGGML_METAL=OFF'],
    });
    const win = planInstall('win32', 'x64', { ...vm, gpu: { vendor: 'nvidia', cuda: true } }, noTools);
    expect(win.kind === 'prebuilt' && pickAsset(nightly.assets, win.asset)?.name).toBe('whisper-bin-win-cuda-12.4.0-x64.zip');
  });

  it('builds from source when asked', () => {
    expect(planInstall('linux', 'x64', vm, noTools, { fromSource: true })).toMatchObject({ kind: 'source', backend: 'cpu' });
  });
});
