import { describe, expect, it } from "vitest";
import { type Email, renderHtml, renderText } from "../src/email";

const email: Email = {
  subject: "s",
  heading: "Box <b1> stopped",
  blocks: [
    { p: "Run `gpushed start` & see https://gpushed.dev." },
    { cmds: [["gpushed up", "start a box"], ["gpushed topup"]] },
    { note: "small print" },
  ],
};

describe("email templates", () => {
  it("escapes text, shows code spans as code and links URLs", () => {
    const h = renderHtml(email);
    expect(h).toContain("Box &lt;b1&gt; stopped");
    expect(h).toContain("&amp; see");
    expect(h).toMatch(/<code[^>]*>gpushed start<\/code>/);
    expect(h).toContain('<a href="https://gpushed.dev" style'); // the trailing "." is not part of the link
    expect(h).toContain("# start a box");
  });

  it("renders a plain-text alternative with aligned commands", () => {
    const t = renderText(email);
    expect(t.startsWith("Box <b1> stopped\n\n")).toBe(true);
    expect(t).toContain("  gpushed up      start a box\n  gpushed topup");
    expect(t).toContain("small print");
    expect(t).toContain("https://gpushed.dev");
  });
});

describe("email styles", () => {
  it("closes every style attribute where it should (no stray double quotes inside)", () => {
    const h = renderHtml(email);
    const opened = h.split('style="').length - 1;
    expect(h.match(/style="[^"]*"(?=[\s>])/g)?.length).toBe(opened);
  });
});
