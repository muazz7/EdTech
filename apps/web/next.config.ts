import type { NextConfig } from 'next';

/** Section 17.6. Cloudflare sits in front of this and adds WAF + Bot Fight
 *  Mode; these are the origin-level headers. */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // packages/* ship TypeScript source, not build output.
  transpilePackages: ['@edtech/core', '@edtech/db', '@edtech/shared'],

  experimental: {
    // Keeps the service role key and the VdoCipher secret out of anything that
    // could be bundled for the client.
    serverActions: { bodySizeLimit: '2mb' },
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },

  webpack(config) {
    // packages/* are written as real Node ESM: relative imports carry an
    // explicit .js extension, which is what lets packages/core lift into a
    // standalone Hono/Fastify service unchanged (Section 3.2). The bundler
    // consumes the TypeScript source, so map the specifier back.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
