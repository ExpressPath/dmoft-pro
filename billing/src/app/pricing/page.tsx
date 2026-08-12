import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Proプラン" };

export default function Pricing() {
  return (
    <main id="main-content">
      <p className="mode-label">DMOFT PRO</p>
      <h1>Proプラン</h1>
      <p>月額または年額の継続課金は、サインイン済みDMOFT Proアプリから開始します。</p>
      <section className="card" aria-labelledby="launch-plan-heading">
        <h2 id="launch-plan-heading">提供する機能</h2>
        <ul>
          <li>ローカルでのライブカメラ読み取り</li>
          <li>適応型の光学スキャン制御</li>
          <li>1契約につき最大3台の登録端末鍵</li>
          <li>端末バインドされたオフラインライセンス</li>
        </ul>
        <p>Hybrid LAN、Wi-Fi Direct、USB転送はロードマップ機能で、現在のプランには含まれません。</p>
      </section>
      <section className="card" aria-labelledby="checkout-heading">
        <h2 id="checkout-heading">決済について</h2>
        <p>
          アプリがOIDCアクセストークンを使用してStripe Checkout Sessionを要求します。
          最終価格、更新周期、税金、利用条件はStripeの決済画面で確認します。
        </p>
      </section>
      <p><Link href="/?mode=pro">Free / Pro選択へ戻る</Link></p>
    </main>
  );
}
