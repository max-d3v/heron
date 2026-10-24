export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.round((now - ts) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 60) return `in ${f}s`;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    return `in ${Math.round(f / 3600)}h`;
  }
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "just now", "5m ago", "3d ago". */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "";
  const r = relativeTime(Math.min(ts, now), now);
  if (r === "now") return "just now";
  return /^\d/.test(r) ? `${r} ago` : r;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
