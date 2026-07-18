/** @type {import('next').NextConfig} */
const nextConfig = {
  // Off in dev: StrictMode double-invokes effects, which double-mounts the MapLibre
  // map (create -> remove -> recreate) and can leave a blank canvas.
  reactStrictMode: false,
  // The frontend talks to the SimZoner backend Worker over HTTP (NEXT_PUBLIC_API_BASE),
  // so this Pages app needs no direct bindings. Deploy with `npm run pages:build`.
};

export default nextConfig;
