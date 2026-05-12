/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // NOTE: NEXT_PUBLIC_-prefixed env vars get baked into the client bundle.
    // The 'STRIPE_SECRET' name was accidentally given the public prefix
    // by the AI assistant that scaffolded the project. (This is the bug.)
    NEXT_PUBLIC_STRIPE_SECRET: "sk_" + "live_" + "isitsafebroVibeNotesFAKEdemokeyABC123XYZ456",
    NEXT_PUBLIC_APP_NAME: "VibeNotes",
  },
  reactStrictMode: false,
  // Skip production type-checking to keep `next dev` boot fast for the demo
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
