/**
 * Find local model servers and print the env lines that enable them.
 *
 *   npx tsx providers/llm-local/src/detect.ts [--json] [--timeout <ms>]
 *
 * Node only (reads RAM and runs nvidia-smi when present). The package entry
 * never imports this file, so the browser build stays free of Node built-ins.
 * The probing itself is detectLocalServers() in detection.ts.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { createContext } from '@vid2context/core';
import { type DetectedModel, type DetectionReport, detectLocalServers, type Hardware } from './detection.ts';

/** NVIDIA GPUs from nvidia-smi; empty when it is missing or fails. */
export function nvidiaGpus(): Promise<NonNullable<Hardware['gpus']>> {
  return new Promise((done) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return done([]);
        const gpus = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name, total, free] = line.split(',').map((s) => s.trim());
            return { name: name ?? 'GPU', memoryTotalMb: Number(total), memoryFreeMb: Number(free) };
          })
          .filter((g) => Number.isFinite(g.memoryTotalMb));
        done(gpus);
      },
    );
  });
}

export async function hardware(): Promise<Hardware> {
  return { totalRamBytes: totalmem(), freeRamBytes: freemem(), gpus: await nvidiaGpus() };
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function modelLine(m: DetectedModel): string {
  const bits = [
    m.task,
    m.parameterSize,
    m.quantization,
    m.contextLength ? `${m.contextLength.toLocaleString('en-US')} ctx` : undefined,
    m.sizeBytes ? gb(m.sizeBytes) : undefined,
    m.capabilities.filter((c) => c !== 'completion').join(','),
  ].filter(Boolean);
  return `  ${m.id.padEnd(36)} ${bits.join('  ')}`;
}

const HOW: Record<string, string> = {
  api: 'its API',
  header: 'its Server header',
  response: 'its /v1/models response',
  port: 'its port only',
};

export function renderReport(r: DetectionReport): string {
  const out: string[] = ['Local model servers', ''];
  if (r.servers.length === 0) out.push('  none found on the default ports', '');
  for (const s of r.servers) {
    out.push(`${s.name}${s.version ? ` ${s.version}` : ''}  ${s.baseUrl}  (identified by ${HOW[s.identifiedBy]})`);
    if (s.models.length === 0) out.push('  no models installed');
    out.push(...s.models.map(modelLine), '');
  }
  const hw = r.hardware;
  if (hw) {
    const ram = hw.totalRamBytes
      ? `${gb(hw.totalRamBytes)} RAM${hw.freeRamBytes ? ` (${gb(hw.freeRamBytes)} free)` : ''}`
      : 'RAM unknown';
    const gpu = hw.gpus?.length
      ? hw.gpus.map((g) => `${g.name} ${(g.memoryTotalMb / 1024).toFixed(1)} GB`).join(', ')
      : 'no NVIDIA GPU found';
    out.push(`Hardware: ${ram}, ${cpus().length} CPU threads, ${gpu}`, '');
  }
  if (r.recommendations.length > 0) {
    out.push('Recommended');
    for (const rec of r.recommendations) out.push(`  ${rec.task.padEnd(15)} ${rec.model} on ${rec.server}: ${rec.why}`);
    out.push('');
  }
  if (r.env.length > 0) out.push('Paste into .env:', '', ...r.env, '');
  if (r.suggestions.length > 0) out.push('Next steps', ...r.suggestions.map((s) => (s.startsWith('  ') ? s : `  ${s}`)), '');
  return out.join('\n');
}

function loadEnv(): void {
  const files = [process.env.VID2CONTEXT_ENV_FILE, resolve(process.cwd(), '.env')].filter((p): p is string => Boolean(p));
  for (const f of new Set(files.map((p) => resolve(p)))) if (existsSync(f)) process.loadEnvFile(f);
}

async function main(argv: string[]): Promise<void> {
  const asJson = argv.includes('--json');
  const t = argv.indexOf('--timeout');
  const timeoutMs = t !== -1 ? Number(argv[t + 1]) : undefined;
  loadEnv();
  const ctx = createContext({ runtime: 'node', env: process.env as Record<string, string> });
  const report = await detectLocalServers(ctx, { timeoutMs, hardware: await hardware() });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
