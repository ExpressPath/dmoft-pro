import Link from "next/link";

type ProductMode = "free" | "pro";

type PageProps = {
  searchParams: Promise<{ mode?: string | string[] }>;
};

const freeFeatures = [
  {
    title: "生成・読み取り",
    description: "画像ファイルからDMOFTフレームを生成し、撮影済み画像をローカルで復元します。",
  },
  {
    title: "安全な光学プロトコル",
    description: "受信者に束縛した暗号化、チャンクAEAD、内外FEC、改ざん検出を共通実装で利用できます。",
  },
  {
    title: "Communityライセンス",
    description: "コアプロトコルと画像ベースのワークフローをApache-2.0で公開しています。",
  },
] as const;

const proFeatures = [
  {
    title: "ライブカメラ読み取り",
    description: "明示的な許可操作の後、端末内のローカルクライアントからカメラを使用します。",
  },
  {
    title: "適応型スキャン",
    description: "色分離、フレーム損失、幾何信頼度に応じて読み取り条件を動的に調整します。",
  },
  {
    title: "端末バインドライセンス",
    description: "Stripe Entitlementsを短期のEd25519署名ライセンスへ変換し、端末鍵に束縛します。",
  },
] as const;

function ModeSwitch({ mode }: { mode: ProductMode }) {
  return (
    <nav className="mode-switch" aria-label="FreeとProの切り替え">
      <Link
        className={mode === "free" ? "mode-option active free" : "mode-option"}
        href="/?mode=free"
        aria-current={mode === "free" ? "page" : undefined}
      >
        <span>Free</span>
        <small>画像から生成・読み取り</small>
      </Link>
      <Link
        className={mode === "pro" ? "mode-option active pro" : "mode-option"}
        href="/?mode=pro"
        aria-current={mode === "pro" ? "page" : undefined}
      >
        <span>Pro</span>
        <small>ライブカメラ・適応制御</small>
      </Link>
    </nav>
  );
}

function FeatureGrid({ mode }: { mode: ProductMode }) {
  const features = mode === "free" ? freeFeatures : proFeatures;
  return (
    <section className="feature-grid" aria-label={`${mode === "free" ? "Free" : "Pro"}の機能`}>
      {features.map((feature, index) => (
        <article className="feature-card" key={feature.title}>
          <span className="feature-number" aria-hidden="true">0{index + 1}</span>
          <h2>{feature.title}</h2>
          <p>{feature.description}</p>
        </article>
      ))}
    </section>
  );
}

export default async function Home({ searchParams }: PageProps) {
  const requestedMode = (await searchParams).mode;
  const mode: ProductMode = requestedMode === "pro" ? "pro" : "free";
  const isFree = mode === "free";

  return (
    <main id="main-content" className={`product-page ${mode}`}>
      <section className="hero" aria-labelledby="product-heading">
        <p className="eyebrow">Dynamic Multicolor Optical File Transfer</p>
        <h1 id="product-heading">
          ひとつの入口から、<br />
          <span>{isFree ? "Freeで始める。" : "Proで読み取る。"}</span>
        </h1>
        <p className="hero-copy">
          ディスプレイとカメラだけで、暗号化されたファイルを光学転送します。
          FreeとProは同じ安全なプロトコルを使用し、カメラアクセスと運用機能だけを明確に分離します。
        </p>
      </section>

      <ModeSwitch mode={mode} />

      <section className="mode-intro" aria-live="polite">
        <div>
          <p className="mode-label">{isFree ? "DMOFT FREE" : "DMOFT PRO"}</p>
          <h2>{isFree ? "無料で使えるプロトコル基盤" : "実時間キャプチャのための製品層"}</h2>
          <p>
            {isFree
              ? "生成、撮影済み画像の復元、暗号化コンテナ、誤り訂正をCommunity版で利用できます。"
              : "ライブカメラ、適応型光学制御、端末ライセンスをローカルクライアントに追加します。"}
          </p>
        </div>
        <div className="mode-price" aria-label={isFree ? "価格 無料" : "価格 有料プラン"}>
          <strong>{isFree ? "¥0" : "Pro"}</strong>
          <span>{isFree ? "永久無料" : "月額・年額"}</span>
        </div>
      </section>

      <FeatureGrid mode={mode} />

      <section className="action-panel" aria-labelledby="action-heading">
        <div>
          <p className="mode-label">LOCAL-FIRST</p>
          <h2 id="action-heading">
            {isFree ? "Community版から転送を始める" : "Proクライアントを有効化する"}
          </h2>
          <p>
            {isFree
              ? "現在のFree機能は公開リポジトリから利用できます。ブラウザ版ワークスペースは今後ここへ統合します。"
              : "カメラ映像と光学ペイロードは課金サービスへ送信されません。端末内で処理されます。"}
          </p>
        </div>
        <div className="actions">
          {isFree ? (
            <>
              <a className="primary-action" href="https://github.com/ExpressPath/dmoft-community">
                Freeを入手
              </a>
              <Link className="secondary-action" href="/?mode=pro">Proと比較</Link>
            </>
          ) : (
            <>
              <Link className="primary-action pro-action" href="/pricing">Proプランを見る</Link>
              <Link className="secondary-action" href="/account">アカウント</Link>
            </>
          )}
        </div>
      </section>

      <section className="trust-strip" aria-label="共通のセキュリティ原則">
        <span>Receiver-bound encryption</span>
        <span>Authenticated reconstruction</span>
        <span>Local optical processing</span>
        <span>Explicit user confirmation</span>
      </section>
    </main>
  );
}
