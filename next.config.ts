import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
