import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable experimental features for Next.js 15
  experimental: {
    // Server Actions are stable in Next.js 15
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
};

export default nextConfig;
