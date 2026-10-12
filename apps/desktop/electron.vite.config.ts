import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@turbodl/shared"] },
      rollupOptions: { external: ["ffmpeg-static"] },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@turbodl/shared"] },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
