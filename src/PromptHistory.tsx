import { useState } from "react";
import { Star } from "lucide-react";
import { RightDrawer } from "./RightDrawer";
import { confirmAction, type PromptEntry, type PromptUpdate } from "./desktop";

const orderHistory = (entries: PromptEntry[]) =>
  [...entries].sort((a, b) => Number(b.favorite) - Number(a.favorite));

export function PromptQuickChoices({
  entries,
  value,
  disabled,
  onUse,
}: {
  entries: PromptEntry[];
  value: string;
  disabled: boolean;
  onUse: (prompt: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="prompt-choices" role="group" aria-label="快捷提示词">
      {orderHistory(entries)
        .slice(0, 4)
        .map((entry) => {
          const label = entry.prompt.trim().slice(0, 160).replace(/\s+/g, " ");
          return (
            <button
              key={entry.id}
              className="prompt-choice"
              aria-pressed={entry.prompt === value}
              title={label}
              disabled={disabled}
              onClick={() => onUse(entry.prompt)}
            >
              {entry.favorite && (
                <Star size={12} fill="currentColor" aria-label="收藏" />
              )}
              <span>{label}</span>
            </button>
          );
        })}
    </div>
  );
}

export function PromptHistory({
  open,
  entries,
  disabled,
  onClose,
  onUse,
  onUpdate,
}: {
  open: boolean;
  entries: PromptEntry[];
  disabled: boolean;
  onClose: () => void;
  onUse: (prompt: string) => void;
  onUpdate: (update: PromptUpdate) => Promise<void>;
}) {
  const [edit, setEdit] = useState<{ id: string; prompt: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const ordered = open ? orderHistory(entries) : [];
  async function update(action: PromptUpdate) {
    setPending(true);
    setError("");
    try {
      await onUpdate(action);
      if (action.action !== "favorite") setEdit(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <RightDrawer
      open={open}
      onClose={onClose}
      title="提示词历史"
      subtitle="CopyX · AI 提示词命令"
    >
      <p className="help">
        成功执行的提示词自动保存在本机。收藏置顶，快捷键使用最近一次成功执行的版本。
      </p>
      {!entries.length && (
        <p className="help">暂无记录。请先在工作台输入提示词并执行处理。</p>
      )}
      {error && (
        <p className="generator-message error" role="alert">
          {error}
        </p>
      )}
      <ul className="prompt-history-list">
        {ordered.map((entry) => (
          <li key={entry.id} className="prompt-history-entry">
            <div className="prompt-history-tags">
              {entry.favorite && (
                <span>
                  <Star size={13} fill="currentColor" /> 已收藏
                </span>
              )}
              {entry.id === entries[0]?.id && <span>最近执行</span>}
              {entry.prompt !== entry.lastRun.prompt && (
                <span>已编辑，执行后更新快捷键</span>
              )}
            </div>
            {edit?.id === entry.id ? (
              <>
                <label>
                  编辑提示词
                  <textarea
                    aria-label="编辑提示词"
                    value={edit.prompt}
                    disabled={disabled || pending}
                    onChange={(e) =>
                      setEdit({ id: entry.id, prompt: e.target.value })
                    }
                  />
                </label>
                <div className="prompt-history-actions">
                  <button
                    disabled={disabled || pending || !edit.prompt.trim()}
                    onClick={() =>
                      void update({
                        action: "edit",
                        id: entry.id,
                        prompt: edit.prompt,
                      })
                    }
                  >
                    保存提示词
                  </button>
                  <button disabled={pending} onClick={() => setEdit(null)}>
                    取消编辑
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="prompt-history-text">{entry.prompt}</p>
                <div className="prompt-history-actions">
                  <button
                    disabled={disabled || pending}
                    onClick={() => onUse(entry.prompt)}
                  >
                    使用此提示词
                  </button>
                  <button
                    disabled={disabled || pending}
                    onClick={() =>
                      void update({
                        action: "favorite",
                        id: entry.id,
                        favorite: !entry.favorite,
                      })
                    }
                  >
                    {entry.favorite ? "取消收藏" : "收藏"}
                  </button>
                  <button
                    disabled={disabled || pending}
                    onClick={() =>
                      setEdit({ id: entry.id, prompt: entry.prompt })
                    }
                  >
                    编辑
                  </button>
                  <button
                    className="danger"
                    disabled={disabled || pending}
                    onClick={async () => {
                      if (await confirmAction("确定删除这条提示词历史？"))
                        void update({ action: "delete", id: entry.id });
                    }}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </RightDrawer>
  );
}
