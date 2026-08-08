'use client';

import { forwardRef, useId, type ReactNode } from 'react';

/**
 * Primitives for the teacher portal.
 *
 * Style is Flat Design with subtle elevation, per the design-system pass: the
 * generated recommendation was Claymorphism with Comic Neue, which is
 * children's-app styling and wrong for a paid exam-prep product with an admin
 * console. Colours come from the tokens in globals.css and are never hardcoded.
 *
 * Non-negotiables applied throughout:
 *   - 44px minimum interactive height
 *   - focus rings never removed
 *   - disabled state is visually distinct AND carries the attribute
 *   - transitions 150-200ms, colour/opacity only (never layout)
 *   - no emoji as icons; inline SVG only
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ── Button ──────────────────────────────────────────────────────────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, disabled, children, className, ...rest },
  ref,
) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-medium ' +
    'transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2';

  // 44px is the Apple floor and applies to a mouse too — a 28px button is a
  // miss-click generator on a laptop trackpad.
  const sizes = { md: 'min-h-11 px-4 text-sm', sm: 'min-h-9 px-3 text-sm' };

  const variants = {
    // White on --color-primary is 5.36:1. Hover darkens rather than lightens,
    // because lightening this hue drops the label below AA.
    primary:
      'bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)]',
    secondary:
      'border border-[var(--color-border-strong)] bg-[var(--color-surface)] ' +
      'text-[var(--color-foreground)] hover:bg-[var(--color-muted)]',
    ghost: 'text-[var(--color-primary)] hover:bg-[var(--color-cyan-tint)]',
    // Not text-white: in dark mode the danger colour is a light rose, and white
    // on it is unreadable. The token flips with the theme.
    danger:
      'bg-[var(--color-destructive)] text-[var(--color-on-destructive)] hover:brightness-90',
  };

  return (
    <button
      ref={ref}
      // Section 8: a button must be inert during an async operation, or a
      // double-tap submits a payment twice.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(base, sizes[size], variants[variant], className)}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function Spinner({ label }: { label?: string }) {
  return (
    <>
      <svg
        className="size-4 animate-spin motion-reduce:animate-none"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" />
      </svg>
      {/* Screen readers get the state; sighted users get the spinner. */}
      <span className="sr-only">{label ?? 'Loading'}</span>
    </>
  );
}

// ── Field ───────────────────────────────────────────────────────────────────

type FieldProps = {
  label: string;
  /** Persistent helper text, not a placeholder — a placeholder disappears the
   *  moment it is needed most (Section 8). */
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => ReactNode;
};

export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Always a visible label. Placeholder-only labelling fails both screen
          readers and anyone who has started typing. */}
      <label htmlFor={id} className="text-sm font-medium text-[var(--color-foreground)]">
        {label}
        {required && (
          <span className="ml-1 text-[var(--color-destructive)]" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        ...(error ? { 'aria-invalid': true as const } : {}),
      })}

      {/* Error below its own field, and announced. Not a summary at the top of
          the page that the user has to scroll back to. */}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-[var(--color-destructive)]">
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-sm text-[var(--color-muted-foreground)]">
          {hint}
        </p>
      )}
    </div>
  );
}

const controlClasses =
  'w-full min-h-11 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] ' +
  'bg-[var(--color-surface)] px-3 text-base text-[var(--color-foreground)] ' +
  'placeholder:text-[var(--color-muted-foreground)] transition-colors duration-150 ' +
  'aria-[invalid=true]:border-[var(--color-destructive)] disabled:opacity-45';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    // 16px base (text-base) is deliberate: anything smaller triggers iOS
    // auto-zoom on focus, which yanks the layout sideways mid-form.
    return <input ref={ref} className={cx(controlClasses, className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(controlClasses, 'py-2 leading-relaxed', className)} rows={3} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cx(controlClasses, 'pr-8', className)} {...rest} />;
  },
);

// ── Surfaces ────────────────────────────────────────────────────────────────

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'section';
}) {
  return (
    <Tag
      className={cx(
        'rounded-[var(--radius-lg)] border border-[var(--color-border)] ' +
          'bg-[var(--color-surface)] shadow-[var(--shadow-sm)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Chips carry the palette's brightness. The vivid hues are unreadable as text
 * on the page background (cyan is 1.70:1 there), but foreground text ON a tint
 * runs 9-12:1 — so this is where the colour is allowed to be loud.
 *
 * The dot uses the vivid hue while the label uses the foreground token, which
 * keeps the chip bright and the words legible.
 */
const badgeTones: Record<BadgeTone, { chip: string; dot: string }> = {
  neutral: { chip: 'bg-[var(--color-muted)]', dot: 'bg-[var(--color-muted-foreground)]' },
  success: { chip: 'bg-[var(--color-cyan-tint)]', dot: 'bg-[var(--color-success)]' },
  warning: { chip: 'bg-[var(--color-yellow-tint)]', dot: 'bg-[var(--color-yellow-vivid)]' },
  danger: { chip: 'bg-[var(--color-coral-tint)]', dot: 'bg-[var(--color-coral-vivid)]' },
  info: { chip: 'bg-[var(--color-cyan-tint)]', dot: 'bg-[var(--color-cyan-vivid)]' },
};

/**
 * Status badges pair a coloured dot with text. Colour alone must never carry
 * meaning — roughly 1 in 12 men has a colour vision deficiency, and "green
 * means ready" is invisible to them. The words do the work; the colour is
 * reinforcement.
 */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const { chip, dot } = badgeTones[tone];
  return (
    <span
      className={cx(
        'chip-text inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        chip,
      )}
    >
      <span className={cx('size-1.5 rounded-full', dot)} aria-hidden="true" />
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-[var(--color-foreground)]">{title}</h3>
      <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">{body}</p>
      {action}
    </div>
  );
}

/** Skeleton rather than a spinner for anything over ~300ms, so the layout does
 *  not jump when content lands (Section 3: CLS). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        'animate-pulse rounded-[var(--radius-md)] bg-[var(--color-muted)] motion-reduce:animate-none',
        className,
      )}
      aria-hidden="true"
    />
  );
}

/**
 * Determinate progress. Uses the vivid cyan as the fill — a bar is exactly the
 * decorative surface the bright hues are for, and the percentage is written out
 * beside it so the value never depends on reading a colour or a bar length.
 */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex items-center gap-3">
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-muted)]"
      >
        {/* Animating width would thrash layout; a transform keeps it on the
            compositor. */}
        <div
          className="h-full origin-left rounded-full bg-[var(--color-cyan-vivid)] transition-transform duration-200"
          style={{ transform: `scaleX(${clamped / 100})`, width: '100%' }}
        />
      </div>
      <span className="tabular w-12 shrink-0 text-right text-sm text-[var(--color-muted-foreground)]">
        {clamped}%
      </span>
    </div>
  );
}

export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-destructive)] bg-[var(--color-surface)] px-4 py-3"
    >
      <p className="text-sm text-[var(--color-foreground)]">{children}</p>
      {/* Section 8: an error must carry a recovery path, not just a diagnosis. */}
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
