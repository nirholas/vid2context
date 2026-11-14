/**
 * Hardware detection for choosing a whisper.cpp build and model, exported for
 * the CLI's `doctor` command. Probes nvidia-smi, system_profiler and sysctl on
 * macOS, vulkaninfo when present, and `os` for CPU and memory. A missing tool
 * is not an error: it just means that vendor was not found.
 */
import { availableParallelism, totalmem } from 'node:os';
import process from 'node:process';
import type { Env } from '@vid2context/core';
import { probe } from './exec.ts';

export type GpuVendor = 'nvidia' | 'apple' | 'amd' | 'intel' | 'none';

export interface GpuInfo {
  vendor: GpuVendor;
  name?: string;
  vramMb?: number;
  cuda?: boolean;
  metal?: boolean;
  vulkan?: boolean;
}

export interface Hardware {
  gpu: GpuInfo;
  cpuCores: number;
  memoryMb: number;
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total --format=csv`. Returns the
 * GPU with the most memory, or null when there is no data row.
 */
export function parseNvidiaSmi(csv: string): { name: string; vramMb: number } | null {
  const rows = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let best: { name: string; vramMb: number } | null = null;
  for (const row of rows) {
    if (/^name\s*,/i.test(row)) continue;
    const i = row.lastIndexOf(',');
    if (i < 0) continue;
    const name = row.slice(0, i).trim();
    const mem = /([\d.]+)\s*(MiB|GiB)?/i.exec(row.slice(i + 1));
    if (!name || !mem) continue;
    const vramMb = Math.round(Number(mem[1]) * (mem[2]?.toLowerCase() === 'gib' ? 1024 : 1));
    if (!best || vramMb > best.vramMb) best = { name, vramMb };
  }
  return best;
}

const VENDOR_IDS: Record<string, GpuVendor> = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x1022': 'amd',
  '0x8086': 'intel',
  '0x106b': 'apple',
};

/** Parse `vulkaninfo --summary`: the first discrete GPU, else the first non-CPU device. */
export function parseVulkanSummary(text: string): { vendor: GpuVendor; name: string } | null {
  const devices: { vendor: GpuVendor; name: string; type: string }[] = [];
  let cur: { vendorID?: string; deviceName?: string; deviceType?: string } = {};
  const flush = () => {
    if (cur.deviceName) {
      devices.push({
        vendor: VENDOR_IDS[(cur.vendorID ?? '').toLowerCase()] ?? 'none',
        name: cur.deviceName,
        type: cur.deviceType ?? '',
      });
    }
    cur = {};
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*GPU\d+:\s*$/.test(line)) flush();
    const m = /^\s*(vendorID|deviceName|deviceType)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) (cur as Record<string, string>)[m[1] as string] = m[2] as string;
  }
  flush();
  const real = devices.filter((d) => !/CPU/i.test(d.type));
  const pick = real.find((d) => /DISCRETE/i.test(d.type)) ?? real[0];
  return pick ? { vendor: pick.vendor, name: pick.name } : null;
}

/** Parse `system_profiler SPDisplaysDataType -json` into the first GPU's name and vendor. */
export function parseSystemProfiler(json: string): { vendor: GpuVendor; name: string; vramMb?: number } | null {
  let data: { SPDisplaysDataType?: Record<string, string>[] };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const gpu = data.SPDisplaysDataType?.[0];
  if (!gpu) return null;
  const name = gpu.sppci_model ?? gpu._name ?? '';
  const v = `${gpu.spdisplays_vendor ?? ''} ${name}`.toLowerCase();
  const vendor: GpuVendor = v.includes('apple')
    ? 'apple'
    : v.includes('nvidia')
      ? 'nvidia'
      : v.includes('amd') || v.includes('ati') || v.includes('radeon')
        ? 'amd'
        : v.includes('intel')
          ? 'intel'
          : 'none';
  const vram = /([\d.]+)\s*(GB|MB)/i.exec(gpu.spdisplays_vram ?? gpu.spdisplays_vram_shared ?? '');
  const vramMb = vram ? Math.round(Number(vram[1]) * (vram[2]?.toUpperCase() === 'GB' ? 1024 : 1)) : undefined;
  return { vendor, name, vramMb };
}

export interface DetectOptions {
  /** Environment for the probes (PATH). Omitted: inherit the parent's. */
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
}

export async function detectHardware(opts: DetectOptions = {}): Promise<Hardware> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const env = opts.env;
  const hw: Hardware = {
    gpu: { vendor: 'none' },
    cpuCores: availableParallelism(),
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
  };

  if (platform === 'darwin') {
    const brand = await probe('sysctl', ['-n', 'machdep.cpu.brand_string'], env);
    if (arch === 'arm64') {
      hw.gpu = { vendor: 'apple', name: brand ?? 'Apple Silicon', metal: true };
    } else {
      const sp = await probe('system_profiler', ['SPDisplaysDataType', '-json'], env, 30_000);
      const gpu = sp ? parseSystemProfiler(sp) : null;
      if (gpu) hw.gpu = { vendor: gpu.vendor, name: gpu.name, vramMb: gpu.vramMb, metal: true };
    }
  } else {
    const smi = await probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv'], env);
    const nv = smi ? parseNvidiaSmi(smi) : null;
    if (nv) hw.gpu = { vendor: 'nvidia', name: nv.name, vramMb: nv.vramMb, cuda: true };
  }

  const vk = await probe('vulkaninfo', ['--summary'], env, 15_000);
  const vkGpu = vk ? parseVulkanSummary(vk) : null;
  if (vkGpu) {
    if (hw.gpu.vendor === 'none') hw.gpu = { vendor: vkGpu.vendor, name: vkGpu.name, vulkan: true };
    else hw.gpu.vulkan = true;
  }
  return hw;
}

/** One line for setup and doctor output. */
export function describeHardware(hw: Hardware): string {
  const g = hw.gpu;
  const gpu =
    g.vendor === 'none'
      ? 'no GPU detected'
      : `${g.vendor} GPU${g.name ? ` (${g.name})` : ''}${g.vramMb ? `, ${Math.round(g.vramMb / 1024)} GB` : ''}${[
          g.cuda && 'CUDA',
          g.metal && 'Metal',
          g.vulkan && 'Vulkan',
        ]
          .filter(Boolean)
          .map((x) => `, ${x}`)
          .join('')}`;
  return `${gpu}; ${hw.cpuCores} CPU threads; ${Math.round(hw.memoryMb / 1024)} GB memory`;
}
