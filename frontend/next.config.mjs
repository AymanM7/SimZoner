/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The frontend talks to the SimZoner backend Worker over HTTP (NEXT_PUBLIC_API_BASE),
  // so this Pages app needs no direct bindings. Deploy with `npm run pages:build`.
};

export default nextConfig;
