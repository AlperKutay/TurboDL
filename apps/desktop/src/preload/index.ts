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
  probeStream: (id, index) => invoke("probeStream", id, index),
  confirmMedia: (id, choice, decision) => invoke("confirmMedia", id, choice, decision),
  findInstagram: (id) => invoke("findInstagram", id),
  confirmInstagram: (id, indices, mode) => invoke("confirmInstagram", id, indices, mode),
  instagramSignIn: (id) => invoke("instagramSignIn", id),
  instagramAccount: () => invoke("instagramAccount"),
  instagramSignOut: () => invoke("instagramSignOut"),
  savedCollections: (refresh) => invoke("savedCollections", refresh),
  savedPage: (source, cursor) => invoke("savedPage", source, cursor),
  openSavedPicks: (ids) => invoke("openSavedPicks", ids),
  backupPlan: (id) => invoke("backupPlan", id),
  startBackup: (id) => invoke("startBackup", id),
  stopBackup: () => invoke("stopBackup"),
  continueBackup: () => invoke("continueBackup"),
  profileLoad: (username) => invoke("profileLoad", username),
  profilePage: (username, cursor) => invoke("profilePage", username, cursor),
  openProfilePicks: (username, ids) => invoke("openProfilePicks", username, ids),
  profileBackupPlan: (username) => invoke("profileBackupPlan", username),
  startProfileBackup: (username) => invoke("startProfileBackup", username),
  instagramProfiles: () => invoke("instagramProfiles"),
  removeInstagramProfile: (id) => invoke("removeInstagramProfile", id),
  closeProfile: (username) => invoke("closeProfile", username),
  takeOpenRequest: () => invoke("takeOpenRequest"),
  cancelCountdown: () => invoke("cancelCountdown"),
  installExtension: () => invoke("installExtension"),
  copyText: (text) => invoke("copyText", text),
  openReleasesPage: () => invoke("openReleasesPage"),
  readClipboardText: () => invoke("readClipboardText"),
  closeWindow: () => invoke("closeWindow"),
};

contextBridge.exposeInMainWorld("turbodl", api);
