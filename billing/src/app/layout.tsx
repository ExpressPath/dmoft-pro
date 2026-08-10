import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "DMOFT — Free / Pro Optical Transfer",
    template: "%s | DMOFT",
  },
  description: "FreeとProを同じ入口から選べる、安全な光学ファイル転送プロトコル",
  referrer: "no-referrer",
};

const siteHeader = (
  <header className="site-header">
    <Link className="brand" href="/">
      <span className="brand-mark" aria-hidden="true" />
      DMOFT
    </Link>
    <nav aria-label="メインナビゲーション">
      <ul>
        <li><Link href="/?mode=free">Free</Link></li>
        <li><Link href="/?mode=pro">Pro</Link></li>
        <li><Link href="/account">Account</Link></li>
      </ul>
    </nav>
  </header>
);

const siteFooter = (
  <footer className="site-footer">
    <p>Community core: Apache-2.0</p>
    <p>Pro product layer: BSL 1.1・本番利用には商用ライセンスが必要です。</p>
  </footer>
);

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <a className="skip-link" href="#main-content">メインコンテンツへ移動</a>
        {siteHeader}
        {children}
        {siteFooter}
      </body>
    </html>
  );
}
