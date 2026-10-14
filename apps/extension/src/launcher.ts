import { NATIVE_HOST_NAME } from "@turbodl/shared";
import { ping } from "./bridge";

const POLL_MS = 500;
let attempt: Promise<boolean> | null = null;

/** Ask the native host to start TurboDL; false when the host is not installed (app never opened). */
export async function launchApp(): Promise<boolean> {
  try {
    const reply = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "launch" })) as { ok?: unknown } | undefined;
    return reply?.ok === true;
  } catch {
    return false;
  }
}

/** True once the app answers; starts it through the native host when it is closed. Parallel callers share one start. */
export function ensureApp(timeoutMs = 20_000): Promise<boolean> {
  attempt ??= startAndWait(timeoutMs).finally(() => {
    attempt = null;
  });
  return attempt;
}

async function startAndWait(timeoutMs: number): Promise<boolean> {
  if (await ping()) return true;
  if (!(await launchApp())) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (await ping()) return true;
  }
  return false;
}
