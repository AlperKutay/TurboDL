import type { Category } from "./model";

export const CATEGORY_ORDER: Category[] = ["video", "music", "programs", "archives", "documents", "images", "other"];

export const CATEGORY_LABELS: Record<Category, string> = {
  video: "Video",
  music: "Music",
  programs: "Programs",
  archives: "Archives",
  documents: "Documents",
  images: "Images",
  other: "Other",
};

const EXTENSIONS: Record<Exclude<Category, "other">, string[]> = {
  video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts", "m2ts"],
  music: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff"],
  programs: ["exe", "msi", "msix", "dmg", "pkg", "apk", "deb", "rpm", "appimage"],
  archives: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "img", "cab"],
  documents: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "epub"],
  images: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "heic", "psd", "ico"],
};

const MIME_EXTENSIONS: Record<string, string> = {
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-rar-compressed": "rar",
  "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z",
  "application/gzip": "gz",
  "application/x-gzip": "gz",
  "application/x-tar": "tar",
  "application/x-bzip2": "bz2",
  "application/x-xz": "xz",
  "application/x-iso9660-image": "iso",
  "application/x-msdownload": "exe",
  "application/x-msdos-program": "exe",
  "application/x-msi": "msi",
  "application/x-apple-diskimage": "dmg",
  "application/vnd.android.package-archive": "apk",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/epub+zip": "epub",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-flv": "flv",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export const DEFAULT_CAPTURE_EXTENSIONS: string[] = [
  ...EXTENSIONS.video.filter((e) => e !== "ts" && e !== "m2ts"),
  ...EXTENSIONS.music,
  ...EXTENSIONS.programs,
  ...EXTENSIONS.archives,
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
  "bin",
];

export function getExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function extensionFromMime(mime: string | null | undefined): string {
  if (!mime) return "";
  return MIME_EXTENSIONS[mime.split(";")[0].trim().toLowerCase()] ?? "";
}

export function categorize(filename: string, mime?: string | null): Category {
  const ext = getExtension(filename) || extensionFromMime(mime);
  if (!ext) return "other";
  for (const category of CATEGORY_ORDER) {
    if (category !== "other" && EXTENSIONS[category].includes(ext)) return category;
  }
  return "other";
}
