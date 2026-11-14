/** The three-step strip under the input. */
import { Captions, Copy, Link2, Sparkles } from 'lucide-react';
import { SectionTitle } from '../ui.tsx';

const STEPS = [
  {
    icon: Link2,
    title: 'Paste or drop',
    text: 'A link to a video, playlist or podcast, or a video or audio file from your computer.',
  },
  {
    icon: Captions,
    title: 'We get the words',
    text: 'Captions when the video has them, otherwise speech-to-text. Free and local options are always tried first.',
  },
  {
    icon: Copy,
    title: 'Copy, download or chat',
    text: 'Every format as a file, a .zip of all of them, text ready to paste into an agent, or a chat with the model you pick.',
  },
];

export function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="space-y-4">
      <SectionTitle id="how-title" icon={<Sparkles className="size-[18px] text-muted" strokeWidth={1.75} aria-hidden />}>
        How it works
      </SectionTitle>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-v2c-lg border border-border bg-surface p-5">
            <div className="mb-4 flex items-center justify-between">
              <span className="flex size-10 items-center justify-center rounded-v2c bg-surface-3 text-fg">
                <s.icon className="size-5" strokeWidth={1.75} aria-hidden />
              </span>
              <span className="font-mono text-xs text-subtle" aria-hidden>
                0{i + 1}
              </span>
            </div>
            <h3 className="text-[15px] font-semibold text-fg">
              <span className="sr-only">Step {i + 1}: </span>
              {s.title}
            </h3>
            <p className="mt-1 text-sm text-muted">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
