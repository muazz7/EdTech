import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Bengali } from 'next/font/google';
import './globals.css';

/* Self-hosted by next/font: no render-blocking request to Google, and
   font-display: swap by default so text is never invisible on a weak
   connection. */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/* Course titles, notes and doubt threads are authored in Bangla even though
   the v1 UI is English. Without this the Bangla text falls back to whatever
   the device has and the vertical rhythm breaks. */
const notoBengali = Noto_Sans_Bengali({
  subsets: ['bengali'],
  variable: '--font-bengali',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Master EdTech Platform',
  description: 'Online courses for HSC, SSC and admission preparation.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never set maximumScale or userScalable: false — it blocks pinch-zoom for
  // low-vision students.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${notoBengali.variable}`}>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[1000] focus:rounded focus:bg-[var(--color-primary)] focus:px-4 focus:py-2 focus:text-[var(--color-on-primary)]"
        >
          Skip to main content
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
