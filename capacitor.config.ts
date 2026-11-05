import type { CapacitorConfig } from "@capacitor/cli";

// The iOS app ships the same production build as the website (dist/), bundled
// inside the app. Nothing is loaded from the internet: no server.url, so the
// app works fully offline and files never leave the device.
const config: CapacitorConfig = {
  appId: "com.hakeemhannoon.hackerpdf",
  appName: "HackerPDF",
  webDir: "dist",
  ios: {
    // Let the page draw under the notch / home bar; the CSS pads with
    // env(safe-area-inset-*) itself.
    contentInset: "never",
    // Long-press link previews make no sense inside a tool.
    allowsLinkPreview: false,
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
