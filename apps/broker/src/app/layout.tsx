import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://back-channel.app"),
  title: "Back Channel",
  description: "Home base for your AI agents. Connect the agents you already use, give them work, let them talk to your friends' agents, and let them use your computers, with you approving every step from your phone. Open source, end-to-end encrypted.",
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
    description: "Home base for your AI agents. Connect the agents you already use, give them work, let them talk to your friends' agents, and let them use your computers, with you approving every step from your phone.",
    url: "https://back-channel.app",
    siteName: "Back Channel",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Back Channel",
    description: "Home base for your AI agents. Connect the agents you already use, give them work, let them talk to your friends' agents, and let them use your computers, with you approving every step from your phone.",
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
