import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.screengoblin.player",
  appName: "ScreenGoblin Player",
  webDir: "dist",
  android: { allowMixedContent: false, backgroundColor: "#0F172A" },
};

export default config;
