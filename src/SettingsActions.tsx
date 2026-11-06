import type { ReactNode } from "react";
import { Save } from "lucide-react";

// 保存入口与专项操作共享一个固定区域，具体生效规则由各设置模块负责。
export function SettingsActions({
  onSave,
  disabled,
  saveLabel = "保存设置",
  status,
  children,
}: {
  onSave: () => void;
  disabled: boolean;
  saveLabel?: string;
  status: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-actions">
      <div className="settings-actions-status">{status}</div>
      <div className="settings-actions-buttons">
        <button disabled={disabled} onClick={onSave}>
          <Save size={15} />
          {saveLabel}
        </button>
        {children}
      </div>
    </div>
  );
}
