import {
  defineConfig,
  combinePresetAndAppleSplashScreens,
  minimal2023Preset,
} from "@vite-pwa/assets-generator/config";
import { readFile } from "node:fs/promises";

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset: combinePresetAndAppleSplashScreens(minimal2023Preset, {
    darkImageResolver: async () => {
      return await readFile("public/favicon-dark.svg");
    },
    resizeOptions: { background: "#e8e3d8", fit: "contain" },
    darkResizeOptions: { background: "#1e1e2e", fit: "contain" },
    name: (landscape: boolean, size, dark: boolean) =>
      `apple-splash-${landscape ? "landscape" : "portrait"}-${dark ? "dark-" : "light-"}${size.width}x${size.height}.png`,
  }),
  images: ["public/favicon.svg"],
});
