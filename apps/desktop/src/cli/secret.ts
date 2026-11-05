import { SecretInterrupted } from "./main";

/** What the line editor does with typed characters (escape sequences are dropped); `done` ends the line, `abort` is Ctrl+C. */
export function editSecret(text: string, input: string): { text: string; done?: boolean; abort?: boolean } {
  let out = text;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\u001b") {
      // an arrow key, Delete and the like arrive as ESC [ ... letter (or ESC and one character): not part of the secret
      if (input[i + 1] === "[") {
        i += 2;
        while (i < input.length && !(input[i] >= "@" && input[i] <= "~")) i++;
      } else i += input[i + 1] === "O" ? 2 : 1;
      continue;
    }
    if (ch === "\u0003") return { text: out, abort: true };
    if (ch === "\r" || ch === "\n") return { text: out, done: true };
    if (ch === "\u0004") return { text: out, done: true };
    if (ch === "\u007f" || ch === "\b") out = out.slice(0, -1);
    else if (ch >= " ") out += ch;
  }
  return { text: out };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shape of Node's own listener type
type Listener = (...args: any[]) => void;

interface SecretStdin {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
}

/**
 * Reads a secret. On a terminal: `prompt` on stderr, then a line typed without echo (backspace edits it, Enter ends it,
 * Ctrl+C rejects with SecretInterrupted). Piped: all of stdin. The result is trimmed.
 */
export async function readSecret(prompt: string, stdin: SecretStdin, stderr: { write(text: string): unknown }): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    let text = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) text += chunk.toString();
    return text.trim();
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  let onData: ((chunk: string) => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let text = "";
      onData = (chunk) => {
        const step = editSecret(text, chunk);
        text = step.text;
        if (step.abort) reject(new SecretInterrupted());
        else if (step.done) resolve(text.trim());
      };
      stdin.on("data", onData);
    });
  } finally {
    if (onData) stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write("\n");
  }
}
