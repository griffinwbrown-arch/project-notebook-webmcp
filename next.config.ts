import type { NextConfig } from "next";

// React's development build uses eval() for debugging features (e.g.
// reconstructing call stacks). It never uses eval() in production, so we
// relax script-src with 'unsafe-eval' in development only and keep the
// production CSP strict.
const isDevelopment = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "base-uri 'self'",
            "connect-src 'self'",
            "font-src 'self'",
            "form-action 'none'",
            "frame-ancestors 'none'",
            "img-src 'self' data:",
            "object-src 'none'",
            `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
            "style-src 'self' 'unsafe-inline'",
            "worker-src 'none'",
          ].join("; "),
        },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ],
    }];
  },
};

export default nextConfig;
