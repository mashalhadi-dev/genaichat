import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cinematic Gemini AI",
  description: "Cinematic Next.js AI Chat Assistant",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}