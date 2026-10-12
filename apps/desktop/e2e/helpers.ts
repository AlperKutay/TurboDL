import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

export const EXTENSION_ORIGIN_FOR_TESTS = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function httpGet(port: number, urlPath: string, origin = EXTENSION_ORIGIN_FOR_TESTS): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers: { Origin: origin } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

export interface LaunchedApp {
  app: ElectronApplication;
  userData: string;
  baseDir: string;
  port: number;
}

/** Starts the built app (out/) with an isolated profile and the given settings. */
export async function launchApp(settings: Record<string, unknown> = {}): Promise<LaunchedApp> {
  const userData = mkdtempSync(path.join(os.tmpdir(), "turbodl-e2e-"));
  const baseDir = path.join(userData, "downloads");
  mkdirSync(baseDir, { recursive: true });
  const port = await freePort();
  writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bridgePort: port, baseDir, ...settings }));
  const app = await electron.launch({
    args: [path.join(__dirname, "..")],
    env: { ...process.env, TURBODL_USER_DATA: userData } as Record<string, string>,
  });
  return { app, userData, baseDir, port };
}
