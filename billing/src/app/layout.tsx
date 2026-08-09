import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "DMOFT Pro Licensing",
  description: "Subscription and device-bound offline licensing for DMOFT Pro",
  referrer: "no-referrer",
};

const siteHeader = (
  <header className="site-header">
    <Link className="brand" href="/">
      DMOFT Pro
    </Link>
    <nav aria-label="Primary navigation">
      <ul>
        <li><Link href="/pricing">Plan</Link></li>
        <li><Link href="/account">Account</Link></li>
      </ul>
    </nav>
  </header>
);

const siteFooter = (
  <footer className="site-footer">
    <p>Publicly inspectable BSL 1.1 source. Production use requires a commercial subscription.</p>
  </footer>
);

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        {siteHeader}
        {children}
        {siteFooter}
      </body>
    </html>
  );
}
