/**
 * Inline SVG icons.
 *
 * No emoji as structural icons: they are font-dependent, render differently on
 * every platform, and cannot be driven by design tokens. No icon library
 * either — these few paths cost nothing, where a package costs kilobytes over
 * the uneven connections Section 1.4 names as a constraint.
 *
 * One visual language throughout: 24x24 viewBox, 1.5 stroke, round caps.
 * `currentColor` so they inherit text colour and theme automatically.
 */

type IconProps = { className?: string };

function Svg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-5'}
      // Decorative: every icon here sits beside a text label or inside a
      // button that carries its own accessible name.
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 15 6-6 6 6" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </Svg>
);

export const GripIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="18" r="1" />
  </Svg>
);

export const VideoIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="m16 10 5-3v10l-5-3" />
  </Svg>
);

export const DocumentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3v5h5" />
    <path d="M6 3h8l5 5v13a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0V3Z" />
    <path d="M9 13h6M9 17h6" />
  </Svg>
);

export const ImageIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="m4 18 5-5 4 4 3-3 4 4" />
  </Svg>
);

export const QuizIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.7v.5" />
    <circle cx="12" cy="17.5" r="0.5" />
    <circle cx="12" cy="12" r="9" />
  </Svg>
);

export const ClipboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3h6v1" />
    <path d="M9 11h6M9 15h4" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

/** Maps a lesson type to its icon. One filled/outline discipline across the
 *  whole tree, so nothing reads as a different hierarchy level. */
export function LessonTypeIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'video':
      return <VideoIcon className={className} />;
    case 'pdf':
      return <DocumentIcon className={className} />;
    case 'note':
    case 'image':
      return <ImageIcon className={className} />;
    case 'quiz':
      return <QuizIcon className={className} />;
    case 'assignment':
      return <ClipboardIcon className={className} />;
    default:
      return <DocumentIcon className={className} />;
  }
}
