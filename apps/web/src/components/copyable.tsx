'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A value the student has to reproduce exactly in a wallet app.
 *
 * Section 8.1 asks for the bKash/Nagad number "shown as copyable text". A
 * transfer to a mistyped number is unrecoverable, and a mistyped reference code
 * means the teacher cannot match the payment — so copying has to be one tap,
 * and the value has to be legible when typed by hand instead.
 *
 * Tabular figures and wide tracking are not decoration here: they are what make
 * 01711223344 checkable digit by digit.
 */
export function Copyable({
  value,
  label,
  size = 'md',
}: {
  value: string;
  label: string;
  size?: 'md' | 'lg';
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Older browsers and insecure origins have no clipboard API. The value is
      // selectable text either way, so this degrades to "read it and type it"
      // rather than breaking.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
        <p
          className={`tabular select-all font-semibold tracking-wider text-[var(--color-foreground)] ${
            size === 'lg' ? 'text-xl' : 'text-base'
          }`}
        >
          {value}
        </p>
      </div>

      <button
        type="button"
        onClick={() => void copy()}
        className="min-h-11 shrink-0 rounded-[var(--radius-sm)] px-3 text-sm font-medium text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-cyan-tint)]"
      >
        {copied ? 'Copied' : 'Copy'}
        <span className="sr-only"> {label}</span>
      </button>

      {/* Announced rather than relying on the button label changing colour. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ''}
      </span>
    </div>
  );
}
