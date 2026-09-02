import type { NextConfig } from 'next';

/**
 * El navegador habla con `/api/*` (mismo origen) y Next reenvía al API (D-015).
 * Así las cookies httpOnly del API son first-party en el dominio del web.
 */
const apiUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ayr/shared'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
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
