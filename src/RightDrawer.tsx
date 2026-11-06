import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
export function RightDrawer({
  open,
  onClose,
  title,
  subtitle = "CopyX · JavaScript 辅助",
  children,
  contentClassName = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  contentClassName?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open) {
      if (!node.open) node.showModal();
      const previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previous;
        if (node.open) node.close();
      };
    }
    if (node.open) node.close();
  }, [open]);
  return createPortal(
    <dialog
      className="right-drawer"
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <div className="drawer-heading">
        <div>
          <span>{subtitle}</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          className="quiet drawer-close"
          aria-label={`关闭${title}`}
          onClick={onClose}
          autoFocus
        >
          <X size={20} />
        </button>
      </div>
      {open && (
        <div className={`drawer-content ${contentClassName}`}>{children}</div>
      )}
    </dialog>,
    document.body,
  );
}
