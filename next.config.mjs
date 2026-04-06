// import { createMDX } from 'fumadocs-mdx/next';

// const withMDX = createMDX();

// /** @type {import('next').NextConfig} */
// const config = {
//   serverExternalPackages: ['@takumi-rs/image-response'],
//   reactStrictMode: true,
// };

// export default withMDX(config);

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/osc-documentation-censof',
  serverExternalPackages: ['@takumi-rs/image-response'],
  reactStrictMode: true,
  pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'mdx'],
};

export default withMDX(config);
