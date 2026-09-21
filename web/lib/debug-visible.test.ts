import { describe, expect, it } from "vitest";

import { isDebugToggleKey, parseDebugParam } from "@/lib/debug-visible";

describe("parseDebugParam", () => {
  it("opens on ?debug=1, bare ?debug, and ?debug=true", () => {
    expect(parseDebugParam("?debug=1")).toBe(true);
    expect(parseDebugParam("?debug")).toBe(true);
    expect(parseDebugParam("?debug=true")).toBe(true);
  });

  it("stays closed without the param or with ?debug=0", () => {
    expect(parseDebugParam("")).toBe(false);
    expect(parseDebugParam("?interval=1s")).toBe(false);
    expect(parseDebugParam("?debug=0")).toBe(false);
  });
});

describe("isDebugToggleKey", () => {
  it("toggles on backtick from body content", () => {
    expect(isDebugToggleKey({ key: "`", target: { tagName: "BODY" } })).toBe(true);
    expect(isDebugToggleKey({ key: "`", target: null })).toBe(true);
  });

  it("ignores non-backtick keys and editable targets", () => {
    expect(isDebugToggleKey({ key: "d", target: { tagName: "BODY" } })).toBe(false);
    expect(isDebugToggleKey({ key: "`", target: { tagName: "INPUT" } })).toBe(false);
    expect(isDebugToggleKey({ key: "`", target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(isDebugToggleKey({ key: "`", target: { tagName: "SELECT" } })).toBe(false);
    expect(isDebugToggleKey({ key: "`", target: { tagName: "DIV", isContentEditable: true } })).toBe(
      false,
    );
  });
});
