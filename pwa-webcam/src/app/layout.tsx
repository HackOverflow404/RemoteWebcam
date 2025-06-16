import type { Metadata } from "next";
import "./globals.css";
import "./globalicon.css";
import SWRegister from '@/components/SWRegister';

export const metadata: Metadata = {
    title: "PixelStreamer",
    description: "A Progressive Web App to stream webcam video and audio",
    manifest: "/manifest.json",
    icons: {
        icon: "/icons/icon-192x192.png",
        apple: "/icons/icon-192x192.png",
    },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="en">
            <head>
                <link
                    href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined"
                    rel="stylesheet"
                />
                <style>{`
                    body {
                        font-family: "Courier New", Courier, monospace;
                    }
                `}</style>
                <link rel="manifest" href="/manifest.json" />
                <meta name="theme-color" content="#0a0a0a" />
                <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
            </head>
            <body className="antialiased">
                <SWRegister />
                {children}
            </body>
        </html>
    );
}