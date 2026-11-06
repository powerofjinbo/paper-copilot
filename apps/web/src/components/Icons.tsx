/** Small stroke icons (16 px, currentColor). Always decorative: the control carries the label. */
import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconOutline = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 3.5h11M5 6.5h8.5M5 9.5h8.5M2.5 12.5h11" />
    <circle cx="2.6" cy="6.5" r=".4" fill="currentColor" />
    <circle cx="2.6" cy="9.5" r=".4" fill="currentColor" />
  </Svg>
);
export const IconFacts = (p: P) => (
  <Svg {...p}>
    <ellipse cx="8" cy="3.8" rx="5" ry="1.8" />
    <path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
  </Svg>
);
export const IconReview = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4.2l1.2 1.2 2.2-2.4M2.5 9.7l1.2 1.2 2.2-2.4M8 4.5h5.5M8 10h5.5" />
  </Svg>
);
export const IconPlaceholder = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 2.5H3.5v11h2M10.5 2.5h2v11h-2" />
    <path d="M7 8h2" strokeDasharray="1 1.4" />
  </Svg>
);
export const IconQuestion = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 3.5a1 1 0 011-1h9a1 1 0 011 1v7a1 1 0 01-1 1H7l-3 2.2V11.5h-.5a1 1 0 01-1-1z" />
    <path d="M6.6 5.4a1.5 1.5 0 112.1 1.4c-.5.2-.7.5-.7 1" />
    <circle cx="8" cy="9.4" r=".35" fill="currentColor" />
  </Svg>
);
export const IconVoice = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 9.5c1.3-3 2.4-3 3.5 0s2.2 3 3.4 0 2.3-3 4.1-.2" />
    <path d="M2.5 5.5h4M2.5 13h6" />
  </Svg>
);
export const IconSync = (p: P) => (
  <Svg {...p}>
    <path d="M13 6a5 5 0 00-9.3-1.6M3 10a5 5 0 009.3 1.6" />
    <path d="M3.3 2.2v2.4h2.4M12.7 13.8v-2.4h-2.4" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.2l7.5 4.8L5 12.8z" />
  </Svg>
);
export const IconPull = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v7.5M5 7l3 3 3-3M2.5 11v2.5h11V11" />
  </Svg>
);
export const IconPush = (p: P) => (
  <Svg {...p}>
    <path d="M8 10V2.5M5 5.5l3-3 3 3M2.5 11v2.5h11V11" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M13 9.7A5.5 5.5 0 016.3 3a5.5 5.5 0 106.7 6.7z" />
  </Svg>
);
export const IconMonitor = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.8" width="12" height="8.4" rx="1" />
    <path d="M6 13.5h4M8 11.2v2.3" />
  </Svg>
);
export const IconSidebar = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.2" />
    <path d="M6 2.5v11" />
  </Svg>
);
export const IconPdf = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
    <path d="M9 1.8V5h3.5M6 8.5h4.5M6 11h4.5" />
  </Svg>
);
export const IconLocate = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.2" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Svg>
);
export const IconArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Svg>
);
export const IconArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2l3.3 3.3" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 11-1.5-3.6M13 2.8v2.6h-2.6" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />
  </Svg>
);
export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.2l6 10.6H2z" />
    <path d="M8 6.5v3" />
    <circle cx="8" cy="11.2" r=".35" fill="currentColor" />
  </Svg>
);
export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v4" />
    <circle cx="8" cy="5" r=".35" fill="currentColor" />
  </Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z" />
  </Svg>
);
export const IconDraft = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" />
    <path d="M9 4l3 3" />
  </Svg>
);

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
  );
}
