// gpushed's emails, as structured content rendered two ways: an HTML message
// in the gpushed.dev look (table layout and inline styles, which is what mail
// clients render reliably) and its plain-text alternative. Text may hold
// `backticked` commands, shown as code.

export type Block =
  | { p: string } // a paragraph
  | { cmds: [cmd: string, note?: string][] } // a terminal block: commands, each with an optional comment
  | { note: string }; // a small, muted aside

export interface Email {
  subject: string;
  heading: string;
  blocks: Block[];
}

const SITE = "https://gpushed.dev";

const C = {
  bg: "#fbfbf8",
  card: "#ffffff",
  ink: "#151813",
  muted: "#5d6458",
  line: "#e2e4dc",
  accent: "#3f8f1f",
  accentSoft: "#e8f3df",
  termBg: "#11140f",
  termInk: "#dfe6d8",
  termDim: "#8a9584",
  termGreen: "#84e05a",
};
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"; // single quotes: these go in style="..."
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Escape, then show `code` spans as code and bare https URLs as links.
function inline(s: string): string {
  return esc(s)
    .replace(
      /`([^`]+)`/g,
      `<code style="font-family:${MONO};font-size:13px;background:${C.accentSoft};color:${C.ink};padding:1px 5px;border-radius:4px;">$1</code>`,
    )
    .replace(/https:\/\/[^\s<]+[^\s<.,;:)]/g, (u) => `<a href="${u}" style="color:${C.accent};">${u}</a>`);
}

function blockHtml(b: Block): string {
  if ("p" in b) {
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.ink};">${inline(b.p)}</p>`;
  }
  if ("note" in b) {
    return `<p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:${C.muted};">${inline(b.note)}</p>`;
  }
  const rows = b.cmds
    .map(
      ([cmd, note]) =>
        `<div style="white-space:nowrap;"><span style="color:${C.termGreen};">$</span> ${esc(cmd)}</div>` +
        (note ? `<div style="color:${C.termDim};padding:0 0 6px 14px;white-space:normal;"># ${esc(note)}</div>` : ""),
    )
    .join("");
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">` +
    `<tr><td style="background:${C.termBg};color:${C.termInk};border-radius:10px;padding:14px 16px;` +
    `font-family:${MONO};font-size:13px;line-height:1.6;">${rows}</td></tr></table>`
  );
}

export function renderHtml(e: Email): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(e.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${SANS};">
<tr><td style="padding:0 4px 16px;">
<a href="${SITE}" style="text-decoration:none;font-family:${MONO};font-size:16px;font-weight:700;color:${C.ink};">` +
    `<span style="display:inline-block;background:${C.termBg};color:${C.termGreen};border-radius:6px;padding:2px 7px;margin-right:6px;">&gt;_</span>gpushed</a>
</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:28px 28px 12px;">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${C.ink};">${esc(e.heading)}</h1>
${e.blocks.map(blockHtml).join("\n")}
</td></tr>
<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:${C.muted};">
gpushed: your NVIDIA GPU, one box away. <a href="${SITE}" style="color:${C.muted};">gpushed.dev</a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function renderText(e: Email): string {
  const parts = e.blocks.map((b) => {
    if ("p" in b) return b.p;
    if ("note" in b) return b.note;
    const w = Math.max(...b.cmds.map(([c]) => c.length)) + 3;
    return b.cmds.map(([c, n]) => (n ? `  ${c.padEnd(w)}${n}` : `  ${c}`)).join("\n");
  });
  return `${e.heading}\n\n${parts.join("\n\n")}\n\n--\ngpushed · ${SITE}\n`;
}
