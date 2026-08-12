import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "アカウント" };

export default function Account() {
  return (
    <main id="main-content">
      <p className="mode-label">DMOFT PRO</p>
      <h1>アカウント</h1>
      <p>支払方法、請求書、契約周期、解約は、サインイン済みアプリから開くCustomer Portalで管理します。</p>
      <section className="card" aria-labelledby="device-management-heading">
        <h2 id="device-management-heading">登録端末</h2>
        <p>
          Proプランでは最大3つの端末鍵を登録できます。端末追加は認証済みアプリの登録フローだけを使用し、
          秘密鍵やライセンストークンを共有しないでください。
        </p>
      </section>
      <p><Link href="/?mode=pro">Pro画面へ戻る</Link></p>
    </main>
  );
}
