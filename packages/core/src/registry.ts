import { isRungEnabled } from './chain.ts';
import { Vid2ContextError } from './errors.ts';
import type {
  CaptionsProvider,
  EmbedRung,
  LlmRung,
  Provider,
  ProviderKind,
  SourceProvider,
  StorageProvider,
  SttRung,
  VideoRung,
  VisualRung,
} from './provider.ts';
import type { Ctx, Env, Runtime, VideoRef } from './types.ts';

export interface ProviderHealth {
  id: string;
  kind: ProviderKind;
  name: string;
  rungs?: { id: string; service: string; model: string; tier: string; enabled: boolean; requires: string[] }[];
  enabled?: boolean;
}

/** Holds the providers available in one runtime. Built from @vid2context/registry. */
export class Registry {
  readonly providers: Provider[];

  constructor(providers: Provider[], runtime: Runtime) {
    const seen = new Set<string>();
    this.providers = providers.filter((p) => {
      if (!p.runtimes.includes(runtime)) return false;
      if (seen.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`);
      seen.add(p.id);
      return true;
    });
  }

  private ofKind<K extends ProviderKind>(kind: K): Extract<Provider, { kind: K }>[] {
    return this.providers.filter((p): p is Extract<Provider, { kind: K }> => p.kind === kind);
  }

  sources(): SourceProvider[] {
    return this.ofKind('source');
  }
  captions(): CaptionsProvider[] {
    return this.ofKind('captions');
  }
  sttRungs(): SttRung[] {
    return this.ofKind('stt').flatMap((p) => p.rungs());
  }
  llmRungs(): LlmRung[] {
    return this.ofKind('llm').flatMap((p) => p.rungs());
  }
  embedRungs(): EmbedRung[] {
    return this.ofKind('embed').flatMap((p) => p.rungs());
  }
  videoRungs(): VideoRung[] {
    return this.ofKind('video').flatMap((p) => p.rungs());
  }
  visualRungs(): VisualRung[] {
    return this.ofKind('visual').flatMap((p) => p.rungs());
  }
  storages(): StorageProvider[] {
    return this.ofKind('storage');
  }

  /** First source provider that understands the input. Platform-specific sources are tried before catch-all ones. */
  resolve(input: string): { source: SourceProvider; ref: VideoRef } {
    const trimmed = input.trim();
    const sources = [...this.sources()].sort((a, b) => Number(a.catchAll ?? false) - Number(b.catchAll ?? false));
    for (const source of sources) {
      const ref = source.match(trimmed);
      if (ref) return { source, ref };
    }
    throw new Vid2ContextError('unsupported-input', `No source understands "${trimmed.slice(0, 200)}".`, {
      hint: 'Pass a video URL (YouTube, or any site yt-dlp supports when that provider is installed), a podcast feed, or a local media file path.',
    });
  }

  /** The enabled storage backend with the lowest priority, if any. */
  async openStorage(ctx: Ctx): Promise<import('./storage.ts').Storage | null> {
    const enabled = this.storages()
      .filter((s) => s.isEnabled(ctx.env))
      .sort((a, b) => a.priority - b.priority);
    const first = enabled[0];
    return first ? first.create(ctx) : null;
  }

  health(env: Env): ProviderHealth[] {
    return this.providers.map((p) => {
      if ('rungs' in p) {
        return {
          id: p.id,
          kind: p.kind,
          name: p.name,
          rungs: p.rungs().map((r) => ({
            id: r.id,
            service: r.service,
            model: r.model,
            tier: r.tier,
            enabled: isRungEnabled(r, env),
            requires: r.requires,
          })),
        };
      }
      if (p.kind === 'storage') return { id: p.id, kind: p.kind, name: p.name, enabled: p.isEnabled(env) };
      return { id: p.id, kind: p.kind, name: p.name, enabled: true };
    });
  }
}
