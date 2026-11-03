/** Small line icons drawn for Rookery (24×24, currentColor). */

type IconProps = { className?: string };

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function RookIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 20h12M7 17h10l-1-7H8l-1 7ZM6.5 10h11V5h-2.4v2h-2.2V5h-1.8v2H8.9V5H6.5v5Z" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  // A knight's head
  return (
    <svg {...base} className={className}>
      <path d="M7 20h11M8 17h9c0-3-1-5-3-7l1-3-3 1-2-3-1 4c-2 1-3 3-3 5l2 1 2-2" />
    </svg>
  );
}

export function AnalysisIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 4h7v7H4zM11 11h7v7h-7" />
      <circle cx="17" cy="7" r="3" />
      <path d="m19.2 9.2 2 2" />
    </svg>
  );
}

export function ImportIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />
    </svg>
  );
}

export function BotIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 5v3M9.5 13h.01M14.5 13h.01M9.5 16h5" />
    </svg>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5" />
    </svg>
  );
}

export function LogoutIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M14 5h4v14h-4M10 12h9M7 9l-3 3 3 3M4 12h6" />
    </svg>
  );
}

export function FlipIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" />
    </svg>
  );
}

export function ChevronIcon({ className, dir }: IconProps & { dir: 'left' | 'right' | 'first' | 'last' }) {
  const d = {
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    first: 'M17 6l-6 6 6 6M7 6v12',
    last: 'M7 6l6 6-6 6M17 6v12',
  }[dir];
  return (
    <svg {...base} className={className}>
      <path d={d} />
    </svg>
  );
}

export function PuzzleIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M9 4h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v6h-6a2 2 0 1 0-4 0H5v-5a2 2 0 1 0 0-4V4h4Z" />
    </svg>
  );
}
