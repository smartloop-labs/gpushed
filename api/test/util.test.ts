import { describe, expect, it } from "vitest";
import { normalizeUserCode, userCode } from "../src/util";

describe("userCode", () => {
  it("is two groups of four unambiguous symbols", () => {
    for (let i = 0; i < 200; i++) expect(userCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("varies", () => {
    expect(new Set(Array.from({ length: 50 }, userCode)).size).toBe(50);
  });
});

describe("normalizeUserCode", () => {
  it("accepts what people type", () => {
    expect(normalizeUserCode("kq7m-3xwd")).toBe("KQ7M-3XWD");
    expect(normalizeUserCode(" KQ7M 3XWD ")).toBe("KQ7M-3XWD");
    expect(normalizeUserCode("KQ7M3XWD")).toBe("KQ7M-3XWD");
  });

  it("rejects anything that isn't eight symbols", () => {
    expect(normalizeUserCode("KQ7M-3XW")).toBe("");
    expect(normalizeUserCode("")).toBe("");
  });
});
