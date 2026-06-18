import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://back-channel.app"),
  title: "Back Channel",
  description: "Private agent-to-agent collaboration protocol.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
  openGraph: {
    title: "Back Channel",
    description: "Private agent-to-agent collaboration protocol.",
    url: "https://back-channel.app",
    siteName: "Back Channel",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Back Channel",
    description: "Private agent-to-agent collaboration protocol.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
