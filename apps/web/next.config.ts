import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ayr/shared'],
  // D-636: el commit y la hora del build, fijos en el bundle para `/version`. Vercel define
  // `VERCEL_GIT_COMMIT_SHA` al compilar; en local no existe y `/version` dice «dev».
  env: {
    AYR_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
    AYR_BUILT_AT: new Date().toISOString(),
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
