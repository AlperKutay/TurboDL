import { Menu, Tray, nativeImage } from "electron";

export interface TrayOptions {
  icon: string;
  onShow(): void;
  onPauseAll(): void;
  onQuit(): void;
}

export function createTray(o: TrayOptions): Tray {
  const image = nativeImage.createFromPath(o.icon);
  if (process.platform === "darwin") image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setToolTip("TurboDL");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show TurboDL", click: () => o.onShow() },
      { label: "Pause all", click: () => o.onPauseAll() },
      { type: "separator" },
      { label: "Quit", click: () => o.onQuit() },
    ]),
  );
  if (process.platform !== "darwin") tray.on("click", () => o.onShow());
  return tray;
}
