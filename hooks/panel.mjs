// SPDX-License-Identifier: MIT
// Pure render functions. The host API and button handlers live in register.mjs.
import {
  UNKNOWN, contextPercent, knownNumber, metricsFor, modelTitle, percentage,
  printable, progressBar, remainingPercent, remainingTokens, resetDate, resetIn,
  tokens, usageColor,
} from "./format.mjs";

export function panelLayout(columns, maxRows, mode = "auto") {
  const framed = columns >= 32;
  const inner = Math.max(1, columns - (framed ? 4 : 0));
  const groups = inner >= 86
    ? [["context", "five_hour", "seven_day"]]
    : inner >= 57
      ? [["context"], ["five_hour", "seven_day"]]
      : [["context"], ["five_hour"], ["seven_day"]];
  const neededRows = 2 + (inner < 60 ? 2 : 1) + groups.length * 7 + (inner < 80 ? 3 : 2) + 1;
  return {
    columns, inner, framed, groups,
    expanded: mode === "expanded" || (mode === "auto" && columns >= 32 && (maxRows ?? Infinity) >= neededRows),
  };
}

function labelled(Text, label, value, color) {
  return Text({ children: [
    Text({ dimColor: true, children: `${label} ` }),
    Text({ color, children: value }),
  ] });
}

function metricsRow(Box, Text, metrics, width) {
  return Box({ flexDirection: "row", flexWrap: "wrap", columnGap: 2, children: metrics.map((metric) => Box({
    width: Math.min(width, Array.from(`${metric.label} ${metric.value}`).length),
    flexShrink: 0,
    children: labelled(Text, metric.label, metric.value, metric.color),
  })) });
}

function bar(Text, value, width, color) {
  const blocks = progressBar(value, width);
  return Text({ children: [
    Text({ color, children: blocks.filled }),
    Text({ dimColor: true, children: blocks.empty }),
  ] });
}

function card(Box, Text, Button, id, width, data, actions, selected) {
  const isContext = id === "context";
  const reading = data.usage?.rateLimits?.find((limit) => limit.kind === id);
  const percent = isContext ? contextPercent(data.usage?.context) : reading?.percentUsed;
  const color = usageColor(percent);
  const label = isContext ? "КОНТЕКСТ" : id === "five_hour" ? "ЛИМИТ 5h" : "ЛИМИТ 7d";
  const contentWidth = Math.max(1, width - 4);
  const info = isContext
    ? `${tokens(data.usage?.context?.tokens)} / ${tokens(data.usage?.context?.window)} ток`
    : `Осталось ${percentage(remainingPercent(percent))}`;
  const countdown = resetIn(reading?.resetsAt, data.now);
  const bottom = isContext
    ? `Свободно ${tokens(remainingTokens(data.usage?.context))} ток`
    : countdown === "сейчас" ? "Сброс сейчас" : `Сброс через ${countdown}`;
  return Box({
    key: `session-panel-card-${id}`, width, flexDirection: "column", flexShrink: 0,
    borderStyle: "round", borderColor: selected === id ? "cyan" : "gray", paddingX: 1,
    children: [
      Button({ key: `session-panel-detail-${id}`, label, plain: true, onPress: () => actions.select(id) }),
      Text({ color, bold: true, children: `${percentage(percent)}${isContext ? " окна" : " использовано"}` }),
      isContext ? Text({ dimColor: true, children: info }) : bar(Text, percent, contentWidth, color),
      isContext ? bar(Text, percent, contentWidth, color) : Text({ dimColor: true, children: info }),
      Text({ dimColor: true, children: bottom }),
    ],
  });
}

function details(Box, Text, Button, data, selected, actions, width) {
  if (!selected) return null;
  const rows = [];
  if (selected === "context") {
    const breakdown = data.contextDetails?.context?.breakdown;
    if (breakdown && Array.isArray(breakdown.categories)) {
      rows.push(Text({ dimColor: true, children: `Локальная оценка · окно ${tokens(breakdown.rawMaxTokens)} ток` }));
      for (const category of breakdown.categories) {
        const suffix = category.kind === "deferred" ? " · вне окна" : "";
        rows.push(labelled(Text, printable(category.name), `${tokens(category.tokens)} ток${suffix}`, "cyan"));
      }
      if (knownNumber(breakdown.autoCompactThreshold)) {
        rows.push(Text({ dimColor: true, children: `Автосжатие от ${tokens(breakdown.autoCompactThreshold)} ток` }));
      }
    } else {
      rows.push(Text({ dimColor: true, children: "Разбивка контекста пока недоступна." }));
    }
    rows.push(Text({ dimColor: true, children: `Модель ${printable(data.model) || UNKNOWN}` }));
  } else {
    const reading = data.usage?.rateLimits?.find((limit) => limit.kind === selected);
    rows.push(Text({ children: `Использовано ${percentage(reading?.percentUsed)} · осталось ${percentage(remainingPercent(reading?.percentUsed))}` }));
    rows.push(Text({ children: `Сброс: ${resetDate(reading?.resetsAt)}` }));
    rows.push(Text({ dimColor: true, children: "Общий лимит аккаунта · последние показания Claude Code" }));
  }
  return Box({
    key: "session-panel-details", width, flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1,
    children: [
      Box({ flexDirection: "row", flexWrap: "wrap", columnGap: 2, children: [
        Text({ color: "cyan", bold: true, children: selected === "context" ? "ПОДРОБНОСТИ КОНТЕКСТА" : `ЛИМИТ ${selected === "five_hour" ? "5h" : "7d"}` }),
        Button({ key: "session-panel-close-detail", label: "Закрыть", plain: true, dimColor: true, onPress: actions.close }),
      ] }),
      ...rows,
    ],
  });
}

export function drawPanel({ Box, Text, Button }, data, layout, selected, actions) {
  const rows = metricsFor(data.model, data.usage, data.git, data.cwd, data.now);
  const body = [];
  const model = Text({ color: "cyan", bold: true, children: `Модель ${modelTitle(data.model)}` });
  const header = Box({
    flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 2,
    children: [
      Box({ flexDirection: "row", flexWrap: "wrap", columnGap: 2, flexShrink: 1, children: [
        layout.expanded ? Text({ color: "yellow", bold: true, children: "SESSION PANEL" }) : null,
        model,
      ] }),
      Box({ flexDirection: "row", columnGap: 2, children: [
        layout.expanded ? Text({ color: data.usage ? "green" : "gray", children: data.usage ? "● LIVE" : "○ —" }) : null,
        Button({ key: "session-panel-toggle", label: layout.expanded ? "Свернуть" : "Развернуть", hotkey: "v", plain: true, dimColor: true, onPress: actions.toggle }),
      ] }),
    ],
  });
  body.push(header);
  if (layout.expanded) {
    for (const ids of layout.groups) {
      const available = layout.inner - (ids.length - 1);
      const base = Math.floor(available / ids.length);
      body.push(Box({ flexDirection: "row", columnGap: 1, children: ids.map((id, index) =>
        card(Box, Text, Button, id, index === ids.length - 1 ? available - base * index : base, data, actions, selected),
      ) }));
    }
    body.push(Box({ flexDirection: "column", marginTop: 1, children: metricsRow(Box, Text, rows[1], layout.inner) }));
    body.push(details(Box, Text, Button, data, selected, actions, layout.inner));
  } else {
    body.push(metricsRow(Box, Text, rows[0].slice(1), layout.inner));
    body.push(metricsRow(Box, Text, rows[1], layout.inner));
  }
  return Box({
    key: "session-panel", width: layout.columns, flexDirection: "column",
    ...(layout.framed && layout.expanded ? { borderStyle: "round", borderColor: "gray", paddingX: 1 } : {}),
    children: body,
  });
}
