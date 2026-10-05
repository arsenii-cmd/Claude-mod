// SPDX-License-Identifier: MIT

export const UNKNOWN = "—";

export function printable(value) {
  return typeof value === "string"
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 200)
    : "";
}

export function knownNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function tokens(value) {
  return knownNumber(value)
    ? Math.round(value).toLocaleString("en-US").replace(/,/g, " ")
    : UNKNOWN;
}

export function percentage(value) {
  return knownNumber(value) ? `${Number(value.toFixed(1))}%` : UNKNOWN;
}

export function usageColor(value) {
  if (!knownNumber(value)) return "gray";
  if (value >= 90) return "red";
  if (value >= 70) return "yellow";
  return "green";
}

export function contextPercent(context) {
  if (knownNumber(context?.percent)) return context.percent;
  return knownNumber(context?.tokens) && knownNumber(context?.window) && context.window > 0
    ? (context.tokens / context.window) * 100
    : undefined;
}

export function remainingTokens(context) {
  return knownNumber(context?.tokens) && knownNumber(context?.window)
    ? Math.max(0, context.window - context.tokens)
    : undefined;
}

export function remainingPercent(value) {
  return knownNumber(value) ? Math.max(0, 100 - value) : undefined;
}

export function modelTitle(model) {
  const name = printable(model);
  const match = name.match(/^(?:claude-)?(sonnet|opus|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i);
  return match
    ? `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ""}${match[4] ? " · 1M" : ""}`
    : name || UNKNOWN;
}

export function resetDate(resetsAt, timeZone) {
  const date = typeof resetsAt === "string" ? new Date(resetsAt) : null;
  if (!date || !Number.isFinite(date.getTime())) return UNKNOWN;
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium", timeStyle: "short", timeZone: zone,
  }).format(date)} (${zone})`;
}

export function progressBar(value, width) {
  const cells = Math.max(1, Math.floor(width));
  if (!knownNumber(value)) return { filled: "", empty: "·".repeat(cells) };
  const filled = Math.round(Math.min(100, value) / 100 * cells);
  return { filled: "█".repeat(filled), empty: "░".repeat(cells - filled) };
}

export function resetIn(resetsAt, now) {
  const reset = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(reset) || !Number.isFinite(now)) return UNKNOWN;
  const remaining = reset - now;
  if (remaining <= 0) return "сейчас";
  if (remaining < 60_000) return "<1м";
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days}д ${hours}ч ${rest}м`;
  if (hours) return `${hours}ч ${rest}м`;
  return `${rest}м`;
}

export function costText(cost) {
  return knownNumber(cost?.usd) ? `$${cost.usd.toFixed(4)}` : UNKNOWN;
}

export function basename(path) {
  return printable(path).replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || UNKNOWN;
}

export function repositoryName(repo) {
  const remote = typeof repo?.remote === "string" ? repo.remote.trim() : "";
  let path = "";
  try {
    // URL.pathname omits credentials embedded in HTTPS remotes.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
      const url = new URL(remote);
      if (["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
        path = url.pathname;
      }
    } else {
      const ssh = remote.match(/^(?:[^@\s]+@)?[^:\/\\\s]+:(?![\\/])(.+)$/);
      if (ssh && !/^[A-Za-z]:/.test(remote)) path = ssh[1];
    }
  } catch {
    // A local or malformed remote falls back to the working tree's name.
  }
  return printable(path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")) || basename(repo?.root);
}

export function metricsFor(model, usage, git, cwd, now) {
  const context = usage?.context;
  const fill = contextPercent(context);
  const limits = Array.isArray(usage?.rateLimits) ? usage.rateLimits : [];
  const limit = (kind, label) => {
    const reading = limits.find((item) => item.kind === kind);
    return {
      label,
      value: `${percentage(reading?.percentUsed)} · сброс ${resetIn(reading?.resetsAt, now)}`,
      color: usageColor(reading?.percentUsed),
    };
  };
  return [
    [
      { label: "Модель", value: printable(model) || UNKNOWN, color: "cyan" },
      {
        label: "Контекст",
        value: `${tokens(context?.tokens)}/${tokens(context?.window)} ток · ${percentage(fill)}`,
        color: usageColor(fill),
      },
      limit("five_hour", "5h"),
      limit("seven_day", "7d"),
    ],
    [
      { label: "Сессия", value: costText(usage?.cost), color: "green" },
      {
        label: git?.repo ? "Репо" : "Папка",
        value: git?.repo ? repositoryName(git.repo) : basename(cwd),
        color: "cyan",
      },
      { label: "Ветка", value: printable(git?.branch) || UNKNOWN, color: "magenta" },
    ],
  ];
}
