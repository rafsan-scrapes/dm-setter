import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  // The local embedding model (AI setter knowledge retrieval) ships native
  // onnxruntime binaries; it runs in the worker process and must never be
  // bundled by Next.
  serverExternalPackages: ["@huggingface/transformers", "better-sqlite3"],
};

export default nextConfig;
