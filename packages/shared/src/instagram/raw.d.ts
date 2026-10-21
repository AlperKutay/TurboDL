/** Fixtures read as text (Vite's `?raw`), where parsing them first would already lose Instagram's 64-bit ids. */
declare module "*?raw" {
  const text: string;
  export default text;
}
