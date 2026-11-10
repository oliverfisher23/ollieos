import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, strokeWidth = 1.8, children, ...rest }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

export const IconHome = (p: P) => <Base {...p}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></Base>;
export const IconTasks = (p: P) => <Base {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" /></Base>;
export const IconBook = (p: P) => <Base {...p}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5M8 7h7M8 11h5" /></Base>;
export const IconCalendar = (p: P) => <Base {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Base>;
export const IconPeople = (p: P) => <Base {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></Base>;
export const IconGoal = (p: P) => <Base {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" /></Base>;
export const IconSettings = (p: P) => <Base {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></Base>;
export const IconUp = (p: P) => <Base strokeWidth={2} {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Base>;
export const IconPlus = (p: P) => <Base strokeWidth={2.2} {...p}><path d="M12 5v14M5 12h14" /></Base>;
export const IconCheck = (p: P) => <Base strokeWidth={2.5} {...p}><path d="m5 12 5 5 9-10" /></Base>;
export const IconClose = (p: P) => <Base strokeWidth={2} {...p}><path d="M6 6l12 12M18 6 6 18" /></Base>;
export const IconLeft = (p: P) => <Base strokeWidth={2} {...p}><path d="m15 18-6-6 6-6" /></Base>;
export const IconRight = (p: P) => <Base strokeWidth={2} {...p}><path d="m9 18 6-6-6-6" /></Base>;
export const IconSearch = (p: P) => <Base strokeWidth={2} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Base>;
export const IconArrowOut = (p: P) => <Base strokeWidth={2} {...p}><path d="M7 17 17 7M8 7h9v9" /></Base>;
export const IconLock = (p: P) => <Base strokeWidth={2} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Base>;
export const IconMail = (p: P) => <Base {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" /></Base>;
export const IconLogout = (p: P) => <Base {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" /></Base>;
export const IconCompass = (p: P) => <Base {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></Base>;
