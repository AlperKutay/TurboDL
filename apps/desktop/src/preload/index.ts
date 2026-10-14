import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, TurboApi } from "@turbodl/shared";

const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`turbodl:${name}`, ...args);

const api: TurboApi = {
  getSnapshot: () => invoke("getSnapshot"),
  onEvent: (cb) => {
    const listener = (_event: unknown, payload: AppEvent) => cb(payload);
    ipcRenderer.on("turbodl:event", listener);
    return () => {
      ipcRenderer.removeListener("turbodl:event", listener);
    };
  },
  addUrl: (url) => invoke("addUrl", url),
  pause: (ids) => invoke("pause", ids),
  resume: (ids) => invoke("resume", ids),
  remove: (ids, deleteFiles) => invoke("remove", ids, deleteFiles),
  openFile: (id) => invoke("openFile", id),
  showInFolder: (id) => invoke("showInFolder", id),
  refreshUrl: (id, url) => invoke("refreshUrl", id, url),
  startAll: () => invoke("startAll"),
  stopAll: () => invoke("stopAll"),
  updateSettings: (patch) => invoke("updateSettings", patch),
  chooseFolder: (current) => invoke("chooseFolder", current),
  getPending: (id) => invoke("getPending", id),
  confirmDownload: (id, decision) => invoke("confirmDownload", id, decision),
  cancelPending: (id) => invoke("cancelPending", id),
  probeMediaFormats: (id) => invoke("probeMediaFormats", id),
  confirmMedia: (id, choice, decision) => invoke("confirmMedia", id, choice, decision),
  cancelCountdown: () => invoke("cancelCountdown"),
  installExtension: () => invoke("installExtension"),
  copyText: (text) => invoke("copyText", text),
  readClipboardText: () => invoke("readClipboardText"),
  closeWindow: () => invoke("closeWindow"),
};

contextBridge.exposeInMainWorld("turbodl", api);
