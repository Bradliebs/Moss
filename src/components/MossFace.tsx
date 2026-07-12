import mossFaceUrl from "../assets/moss-face.svg";
import { useSettings } from "../lib/settings";

interface MossFaceProps {
  className?: string;
  label?: string;
}

export function MossFace({ className = "h-8 w-8", label = "Moss" }: MossFaceProps): React.ReactElement {
  const customAvatarUrl = useSettings().avatarDataUrl;

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-emerald-500/25 bg-emerald-100 shadow-sm dark:bg-emerald-950 ${className}`}
      role="img"
      aria-label={label}
    >
      <img
        src={customAvatarUrl ?? mossFaceUrl}
        alt=""
        className={customAvatarUrl ? "h-full w-full object-cover" : "h-[112%] w-[112%] max-w-none translate-y-[4%]"}
        aria-hidden="true"
      />
    </span>
  );
}