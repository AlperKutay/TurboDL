export async function cookieHeader(url: string): Promise<string | undefined> {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.length > 0 ? cookies.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
  } catch {
    return undefined;
  }
}

/** Show a red "!" on the toolbar icon for a few seconds (app unreachable, request declined). */
export function flashBadge(text = "!"): void {
  void chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  void chrome.action.setBadgeText({ text });
  setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 4000);
}
