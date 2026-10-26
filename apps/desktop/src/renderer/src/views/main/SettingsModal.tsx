import { useEffect, useState } from "react";
import type { CliStatus, InstallResult, Result, Settings } from "@turbodl/shared";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

/** Chromium browsers load the extension folder from their extensions page. */
const EXTENSION_PAGES = [
  { address: "chrome://extensions", browsers: "(Chrome, Brave, Vivaldi, Arc)" },
  { address: "edge://extensions", browsers: "(Edge)" },
  { address: "opera://extensions", browsers: "(Opera)" },
];

export function SettingsModal({ settings, version, onClose }: { settings: Settings; version: string; onClose(): void }) {
  const [draft, setDraft] = useState(settings);
  const [extensions, setExtensions] = useState(settings.captureExtensions.join(" "));
  const [minKb, setMinKb] = useState(String(Math.round(settings.minCaptureSize / 1024)));
  const [install, setInstall] = useState<InstallResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [cliError, setCliError] = useState("");

  useEffect(() => {
    void api.cliStatus().then(setCli);
  }, []);

  const changeCli = async (action: () => Promise<Result>) => {
    const result = await action();
    setCliError(result.ok ? "" : result.error);
    setCli(await api.cliStatus());
  };

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    const { scheduler: _unused, ...rest } = draft;
    await api.updateSettings({
      ...rest,
      captureExtensions: extensions.split(/[\s,;]+/).filter(Boolean),
      minCaptureSize: Math.max(0, Number(minKb) || 0) * 1024,
    });
    setSaving(false);
    onClose();
  };

  const chooseFolder = async () => {
    const folder = await api.chooseFolder(draft.baseDir);
    if (folder) set("baseDir", folder);
  };

  return (
    <Modal
      title="Settings"
      width={620}
      onClose={onClose}
      footer={
        <>
          <span className="muted footer-note">TurboDL {version}</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            Save
          </button>
        </>
      }
    >
      <h3>Downloads</h3>
      <label className="field">
        <span>Download folder (files are sorted into subfolders by type)</span>
        <div className="field-row">
          <input value={draft.baseDir} onChange={(e) => set("baseDir", e.target.value)} />
          <button type="button" className="btn" onClick={() => void chooseFolder()}>
            Browse…
          </button>
        </div>
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Connections per file (1–16)</span>
          <input type="number" min={1} max={16} value={draft.maxConnections} onChange={(e) => set("maxConnections", Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Simultaneous downloads (1–10)</span>
          <input type="number" min={1} max={10} value={draft.maxConcurrent} onChange={(e) => set("maxConcurrent", Number(e.target.value))} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.confirmBeforeDownload} onChange={(e) => set("confirmBeforeDownload", e.target.checked)} />
        Show a confirmation window before downloading
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.notifyOnComplete} onChange={(e) => set("notifyOnComplete", e.target.checked)} />
        Notify when a download finishes
      </label>

      <h3>Browser</h3>
      <label className="check">
        <input type="checkbox" checked={draft.captureEnabled} onChange={(e) => set("captureEnabled", e.target.checked)} />
        Capture browser downloads
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.watchClipboard} onChange={(e) => set("watchClipboard", e.target.checked)} />
        Capture copied download links (extensions above)
      </label>
      <label className="field">
        <span>File extensions to capture</span>
        <textarea rows={3} value={extensions} onChange={(e) => setExtensions(e.target.value)} />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Minimum file size (KB)</span>
          <input type="number" min={0} value={minKb} onChange={(e) => setMinKb(e.target.value)} />
        </label>
        <label className="field">
          <span>Extension connection port</span>
          <input type="number" min={1024} max={65535} value={draft.bridgePort} onChange={(e) => set("bridgePort", Number(e.target.value))} />
        </label>
      </div>
      <div className="install-box">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void api.installExtension().then(setInstall);
          }}
        >
          Install the browser extension…
        </button>
        {install && !install.ok && <p className="error-text">{install.error}</p>}
        {install?.ok && (
          <ol className="steps">
            <li>
              Open your browser&apos;s extensions page:
              <ul className="pages">
                {EXTENSION_PAGES.map((page) => (
                  <li key={page.address}>
                    <code>{page.address}</code> {page.browsers}{" "}
                    <button type="button" className="link-button" onClick={() => void api.copyText(page.address)}>
                      Copy
                    </button>
                  </li>
                ))}
              </ul>
            </li>
            <li>Turn on “Developer mode”.</li>
            <li>Click “Load unpacked” and choose this folder:</li>
            <li className="path">{install.path}</li>
            <li>The extension starts TurboDL by itself even when it is closed, as long as TurboDL has been opened at least once.</li>
          </ol>
        )}
        <p className="muted">
          Firefox: install the TurboDL add-on (.xpi) from the{" "}
          <button type="button" className="link-button" onClick={() => void api.openReleasesPage()}>
            Releases page
          </button>
          .
        </p>
      </div>

      <h3>Instagram</h3>
      <label className="check">
        <input type="checkbox" checked={draft.instagramByAccount} onChange={(e) => set("instagramByAccount", e.target.checked)} />
        Put Instagram downloads in a folder per account
      </label>
      <p className="muted field-note">Instagram › account (its highlights in Instagram › account › Highlights). Off: single links and Saved picks go to Instagram.</p>

      <h3>Command line</h3>
      <div className="install-box">
        {cli && !cli.supported && <p className="muted">Available in the installed app.</p>}
        {cli?.supported && !cli.installed && (
          <>
            <button type="button" className="btn" onClick={() => void changeCli(api.installCli)}>
              Install command line tool
            </button>
            <p className="muted">Adds the turbodl command to your PATH.</p>
          </>
        )}
        {cli?.supported && cli.installed && (
          <>
            <p className="muted">
              The turbodl command is installed ({cli.where}). Open a new terminal and run <code>turbodl --help</code>.
            </p>
            <button type="button" className="btn" onClick={() => void changeCli(api.removeCli)}>
              Remove
            </button>
          </>
        )}
        {cliError && <p className="error-text">{cliError}</p>}
      </div>

      <h3>System</h3>
      <label className="check">
        <input type="checkbox" checked={draft.launchAtLogin} onChange={(e) => set("launchAtLogin", e.target.checked)} />
        Start TurboDL when the computer starts
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.closeToTray} onChange={(e) => set("closeToTray", e.target.checked)} />
        Keep running in the system tray when the window is closed
      </label>
    </Modal>
  );
}
