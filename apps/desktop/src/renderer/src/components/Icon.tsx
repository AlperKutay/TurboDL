const PATHS = {
  plus: "M12 5v14M5 12h14",
  play: "M7 5l12 7-12 7z",
  pause: "M8 5v14M16 5v14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  playAll: "M3 5l8 7-8 7zM13 5l8 7-8 7z",
  stop: "M6 6h12v12H6z",
  clock: "M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  video: "M3 6h13v12H3zM16 10l5-3v10l-5-3",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  app: "M4 4h16v16H4zM4 9h16",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  doc: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01",
  file: "M6 2h9l5 5v15H6zM14 2v6h6",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  check: "M5 12l5 5L20 7",
  queue: "M4 6h16M4 12h10M4 18h7",
  close: "M6 6l12 12M18 6L6 18",
  bookmark: "M6 3h12v18l-6-4-6 4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
