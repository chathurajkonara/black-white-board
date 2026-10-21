type IconProps = { className?: string };

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const MicIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="8" y1="22" x2="16" y2="22" />
  </svg>
);

export const StopIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const TrashIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

export const UndoIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <path d="M3 10h10a5 5 0 0 1 5 5v1" />
    <polyline points="8 5 3 10 8 15" />
  </svg>
);

export const AlertIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <path d="M12 3 21.5 20 2.5 20Z" />
    <line x1="12" y1="9.5" x2="12" y2="14" />
    <line x1="12" y1="17" x2="12" y2="17.01" />
  </svg>
);

export const ZoomInIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);

export const ZoomOutIcon = ({ className }: IconProps) => (
  <svg className={className} {...base}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);
