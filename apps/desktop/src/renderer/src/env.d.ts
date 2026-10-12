import type { TurboApi } from "@turbodl/shared";

declare global {
  interface Window {
    turbodl: TurboApi;
  }
}

export {};
