/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the app is a pure client-side SPA (no server routes/actions), so
  // it exports to static HTML/JS and deploys straight to Cloudflare Pages — avoiding
  // @cloudflare/next-on-pages, which fails to spawn its build subprocess on Windows.
  output: "export",
  images: { unoptimized: true },
  // Off in dev: StrictMode double-invokes effects, which double-mounts the map
  // (create -> remove -> recreate) and can leave a blank canvas.
  reactStrictMode: false,
  // The frontend talks to the SimZoner backend Worker over HTTP (NEXT_PUBLIC_API_BASE),
  // so this Pages app needs no direct bindings. Deploy with `npm run pages:build`.
};

export default nextConfig;
