import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These ship native/wasm bindings that must not be bundled by Turbopack or webpack.
  serverExternalPackages: [
    "unpdf",
    "pdfjs-dist",
    "mammoth",
    "@napi-rs/canvas",
  ],
  // Resume uploads go through a route handler, not a server action.
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
