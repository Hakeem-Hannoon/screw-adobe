import { defineConfig, type Plugin } from "vite";

// A strict Content-Security-Policy, injected only into production builds
// (Vite's dev server needs inline scripts for hot reload). connect-src 'self'
// means the page physically cannot send your PDF anywhere.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig({
  // Relative base so the build works on GitHub Pages (/screw-adobe/) or anywhere else.
  base: "./",
  plugins: [contentSecurityPolicy()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
