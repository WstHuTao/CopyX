import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";
export function Select(props: ComponentProps<"select">) {
  return (
    <span className="select-control">
      <select {...props} />
      <ChevronDown className="select-chevron" size={16} aria-hidden="true" />
    </span>
  );
}
