import type { ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  /** 初期状態で開いておくか(既定: 閉じる)。頻繁に触るセクションだけtrueにする。 */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * サイドバーの各セクションを折りたたみ可能にする共通ラッパー。ネイティブの
 * `<details>/<summary>` を使うことで開閉状態を自前で管理する必要がない
 * (ブラウザ標準の挙動・アクセシビリティに乗っかる)。
 */
export function CollapsibleSection({ title, defaultOpen = false, children }: CollapsibleSectionProps) {
  return (
    <details className="panel-section" open={defaultOpen}>
      <summary className="panel-section-summary">
        <h2>{title}</h2>
      </summary>
      <div className="panel-section-content">{children}</div>
    </details>
  );
}
