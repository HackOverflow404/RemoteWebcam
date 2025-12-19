import type { Metadata } from "next";
import "./globals.css";
import "./globalicon.css";
import SWRegister from '@/components/SWRegister';
import NetworkStatus from '@/components/NetworkStatus'

export const metadata: Metadata = {
    title: "PixelStreamer",
    description: "A Progressive Web App to stream webcam video and audio",
    manifest: "/manifest.webmanifest",
    icons: {
        icon: "/icons/icon-192x192.png",
        apple: "/icons/icon-192x192.png",
    },
};

export const viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="en">
            <head>
                <link
                    href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined"
                    rel="stylesheet"
                />
                <link rel="manifest" href="/manifest.webmanifest" />
                <meta name="theme-color" content="#0a0a0a" />
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="mobile-web-app-capable" content="yes" />
                <meta
                    name="apple-mobile-web-app-status-bar-style"
                    content="black-translucent"
                />
                <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
            </head>
            <body className="antialiased">
                <div className="pwa-root">
                    <SWRegister />
                    <NetworkStatus />
                    {children}
                </div>
            </body>
        </html>
    );
}