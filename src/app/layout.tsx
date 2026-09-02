import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project: Notebook · WebMCP judge demo",
  description: "Use direct, page-scoped WebMCP controls in the real Project: Notebook interface.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

