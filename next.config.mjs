/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server actions / route handlers only for the pilot; no client secrets.
  },
};

export default nextConfig;
