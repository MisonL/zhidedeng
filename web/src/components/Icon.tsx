import type { ReactNode } from 'react';

const PATHS = {
  left: <path d="m15 5-7 7 7 7" />,
  right: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  star: <path d="m12 4 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z" />,
  comment: <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 11h.01M12 11h.01M16 11h.01" />,
  doc: <path d="M6 4h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 9h6M9 13h6M9 17h3" />,
  book: <path d="M12 7c-2-1.6-4.6-2-8-2v13c3.4 0 6 .4 8 2 2-1.6 4.6-2 8-2V5c-3.4 0-6 .4-8 2zm0 0v13" />,
  bars: <path d="M6 20v-6M12 20V6M18 20v-9" />,
  up: <path d="M8 11v9H4v-9zM8 11l4-7c1.5 0 2.5 1 2.5 2.5V10H19a1.8 1.8 0 0 1 1.8 2.2l-1.4 6.2A2 2 0 0 1 17.5 20H8" />,
  downvote: <path d="M8 13V4H4v9zM8 13l4 7c1.5 0 2.5-1 2.5-2.5V14H19a1.8 1.8 0 0 0 1.8-2.2l-1.4-6.2A2 2 0 0 0 17.5 4H8" />,
  coin: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 8.5h7M12 8.5V16" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
