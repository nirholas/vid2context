/** The three-step strip under the input. */
import { Captions, Copy, Link2 } from 'lucide-react';

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
      <h2 id="how-title" className="text-sm font-semibold uppercase tracking-wide text-muted">
        How it works
      </h2>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-v2c border border-border bg-surface p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-fg">
                {i + 1}
              </span>
              <s.icon className="size-4 text-accent" aria-hidden />
              <h3 className="text-sm font-semibold text-fg">{s.title}</h3>
            </div>
            <p className="text-sm text-muted">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
