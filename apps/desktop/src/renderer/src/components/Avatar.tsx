import { cn } from "../lib/cn";

export function Avatar({ login, url, size = 16, className }: { login: string; url?: string | null; size?: number; className?: string }) {
  const base = url ?? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}`;
  const src = `${base}${base.includes("?") ? "&" : "?"}s=${size * 2}`;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn("shrink-0 rounded-full bg-field", className)}
      style={{ width: size, height: size }}
    />
  );
}
