import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompletionNotifier,
  fileFromArgument,
  notificationIdentity,
  revealDownload,
  showArgument,
  toastXml,
  type NotificationLike,
} from "../src/main/notifications";

describe("notificationIdentity", () => {
  it("keeps the real app's Windows identity for the installed app only", () => {
    expect(notificationIdentity({ isPackaged: true, isolated: false })).toEqual({ appUserModelId: "com.turbodl.app", enabled: true });
    // development runs must not register shortcuts that take over the installed app's notifications
    expect(notificationIdentity({ isPackaged: false, isolated: false })).toEqual({ appUserModelId: "com.turbodl.app.dev", enabled: true });
    // test runs (TURBODL_USER_DATA) show no notifications at all
    expect(notificationIdentity({ isPackaged: true, isolated: true })).toEqual({ appUserModelId: "com.turbodl.app.test", enabled: false });
    expect(notificationIdentity({ isPackaged: false, isolated: true })).toEqual({ appUserModelId: "com.turbodl.app.test", enabled: false });
  });
});

describe("activation arguments", () => {
  it("round-trips a file path, including spaces and non-ASCII letters", () => {
    const file = "C:\\Users\\Zoë\\Downloads\\TurboDL\\Video\\My clip & more.mp4";
    expect(fileFromArgument(showArgument(file))).toBe(file);
  });

  it("ignores arguments that are not ours", () => {
    expect(fileFromArgument("")).toBeNull();
    expect(fileFromArgument("something-else")).toBeNull();
    expect(fileFromArgument("turbodl-show:%E0%A4%A")).toBeNull();
  });
});

describe("toastXml", () => {
  it("escapes the text and carries the launch argument", () => {
    const xml = toastXml({ title: "Download complete", body: 'a <b> & "c".zip', launch: "turbodl-show:x%26y", icon: "C:\\app\\icon.png" });
    expect(xml).toContain('launch="turbodl-show:x%26y"');
    expect(xml).toContain("<text>Download complete</text>");
    expect(xml).toContain("<text>a &lt;b&gt; &amp; &quot;c&quot;.zip</text>");
    expect(xml).toContain('src="file:///C:/app/icon.png"');
    expect(xml.startsWith("<toast")).toBe(true);
  });
});

describe("revealDownload", () => {
  const calls: string[] = [];
  const deps = (existing: string[]) => ({
    exists: (p: string) => existing.includes(p),
    showItemInFolder: (p: string) => void calls.push(`show ${p}`),
    openPath: (p: string) => void calls.push(`open ${p}`),
  });
  const file = path.join("dl", "Video", "clip.mp4");

  it("selects the file in its folder, or opens the folder when the file is gone", () => {
    calls.length = 0;
    expect(revealDownload(file, deps([file]))).toBe("file");
    expect(revealDownload(file, deps([path.dirname(file)]))).toBe("folder");
    expect(revealDownload(file, deps([]))).toBe("none");
    expect(calls).toEqual([`show ${file}`, `open ${path.dirname(file)}`]);
  });
});

class FakeNotification implements NotificationLike {
  shown = false;
  private click: (() => void) | null = null;
  constructor(readonly options: Record<string, unknown>) {}
  on(event: "click", listener: () => void): void {
    if (event === "click") this.click = listener;
  }
  show(): void {
    this.shown = true;
  }
  clickIt(): void {
    this.click?.();
  }
}

describe("CompletionNotifier", () => {
  function setup(platform: NodeJS.Platform, enabled = true) {
    const made: FakeNotification[] = [];
    const revealed: string[] = [];
    const notifier = new CompletionNotifier({
      platform,
      enabled: () => enabled,
      icon: "C:\\app\\icon.png",
      create: (options) => {
        const n = new FakeNotification(options);
        made.push(n);
        return n;
      },
      reveal: (file) => void revealed.push(file),
      keep: 2,
    });
    return { notifier, made, revealed };
  }

  it("on Windows, puts the file in the toast's launch argument and opens it on activation", () => {
    const { notifier, made, revealed } = setup("win32");
    notifier.show("C:\\dl\\clip.mp4");
    expect(made[0].shown).toBe(true);
    const xml = String(made[0].options.toastXml);
    const launch = /launch="([^"]*)"/.exec(xml)![1].replace(/&amp;/g, "&");
    notifier.handleActivation(launch);
    notifier.handleActivation("unrelated");
    expect(revealed).toEqual(["C:\\dl\\clip.mp4"]);
  });

  it.each(["darwin", "linux"] as const)("elsewhere (%s), opens the folder from the notification's click and keeps recent notifications alive", (platform) => {
    const { notifier, made, revealed } = setup(platform);
    notifier.show("/dl/a.zip");
    notifier.show("/dl/b.zip");
    notifier.show("/dl/c.zip");
    expect(made[0].options).toMatchObject({ title: "Download complete", body: "a.zip" });
    made[1].clickIt();
    expect(revealed).toEqual(["/dl/b.zip"]);
    expect(notifier.retained).toBe(2);
  });

  it("shows nothing when notifications are off", () => {
    const { notifier, made } = setup("win32", false);
    notifier.show("C:\\dl\\clip.mp4");
    expect(made).toHaveLength(0);
  });
});
