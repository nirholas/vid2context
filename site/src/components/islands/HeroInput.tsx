/**
 * The hero's link box. Submitting sends the link to the app, which starts the
 * run at once: /app/?url=<encoded>. The server-rendered form already works
 * without JavaScript (GET to /app/ with a `url` field); this island adds
 * validation and the exact encodeURIComponent form.
 */
import { type FormEvent, useId, useState } from 'react';

interface Props {
  action: string;
  placeholder: string;
  button: string;
}

function looksLikeInput(value: string): boolean {
  if (/^https?:\/\/\S+\.\S+/i.test(value)) return true;
  // Bare hosts and YouTube ids are accepted too; the app resolves them.
  return /^[\w-]{11}$/.test(value) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value);
}

export default function HeroInput({ action, placeholder, button }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const errorId = useId();
  const inputId = useId();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = value.trim();
    if (!input) {
      setError('Paste a video link first.');
      return;
    }
    if (!looksLikeInput(input)) {
      setError('That does not look like a link. Paste a full URL, for example https://www.youtube.com/watch?v=jNQXAC9IVRw');
      return;
    }
    setError('');
    window.location.assign(`${action}?url=${encodeURIComponent(input)}`);
  }

  return (
    <form action={action} method="get" onSubmit={submit} className="hero-form" noValidate>
      <label htmlFor={inputId} className="sr-only">
        Video link
      </label>
      <div className="hero-box">
        <svg className="hero-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"
          />
        </svg>
        <input
          id={inputId}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <button type="submit" className="btn btn-primary hero-submit">
          {button}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 12h14M13 6l6 6-6 6"
            />
          </svg>
        </button>
      </div>
      <p id={errorId} className="hero-error" role="alert">
        {error}
      </p>
    </form>
  );
}
