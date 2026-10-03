import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/room.html",
        destination: "/room",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
