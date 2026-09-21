import { describe, expect, it, vi } from "vitest";

import {
  BACKEND_URL_STORAGE_KEY,
  clearStoredBackendUrl,
  normalizeBackendUrl,
  presetBackendUrls,
  readStoredBackendUrl,
  resolveBackendUrl,
  writeStoredBackendUrl,
  type BackendUrlStorage,
} from "@/lib/backend-url";
import { API_BASE_URL } from "@/lib/config";
import { ProtocolError } from "@/lib/protocol";

/**
 * The runtime half of the backend address: what the chooser validates,
 * remembers, and falls back from. Storage is a hand-rolled Map so no DOM is
 * needed — the module only ever touches the three-method surface it names.
 */
function memoryStorage(entries: Record<string, string> = {}): BackendUrlStorage {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("normalizeBackendUrl", () => {
  it("trims whitespace and drops trailing slashes", () => {
    expect(normalizeBackendUrl("  https://tunnel.example.com///  ")).toBe(
      "https://tunnel.example.com",
    );
  });

  it("keeps a path prefix a tunnel may serve under", () => {
    expect(normalizeBackendUrl("https://host.example/prefix/")).toBe(
      "https://host.example/prefix",
    );
  });

  it("rejects an empty input instead of dialing it", () => {
    expect(() => normalizeBackendUrl("   ")).toThrow(ProtocolError);
    expect(() => normalizeBackendUrl("   ")).toThrow(/empty/);
  });

  it("rejects text that is not a URL", () => {
    expect(() => normalizeBackendUrl("not a url")).toThrow(/not a URL/);
  });

  it("rejects schemes the socket half cannot derive ws(s) from", () => {
    expect(() => normalizeBackendUrl("ws://host:8080")).toThrow(/not http\(s\)/);
    expect(() => normalizeBackendUrl("ftp://host/file")).toThrow(/not http\(s\)/);
  });
});

describe("resolveBackendUrl", () => {
  it("opens on the build default with nothing stored", () => {
    expect(resolveBackendUrl(null)).toBe(API_BASE_URL);
    expect(resolveBackendUrl(undefined)).toBe(API_BASE_URL);
    expect(resolveBackendUrl("")).toBe(API_BASE_URL);
    expect(resolveBackendUrl("   ")).toBe(API_BASE_URL);
  });

  it("normalises a stored choice", () => {
    expect(resolveBackendUrl("https://tunnel.example.com//")).toBe(
      "https://tunnel.example.com",
    );
  });

  it("falls back to the default when storage holds garbage, not a blank screen", () => {
    expect(resolveBackendUrl("ws://host:8080")).toBe(API_BASE_URL);
    expect(resolveBackendUrl("not a url")).toBe(API_BASE_URL);
  });
});

describe("presetBackendUrls", () => {
  it("suggests the build default and local dev, without duplicates", () => {
    const presets = presetBackendUrls();
    expect(presets).toContain(API_BASE_URL);
    expect(presets).toContain("http://localhost:8080");
    expect(new Set(presets).size).toBe(presets.length);
  });
});

describe("stored backend URL", () => {
  it("round-trips through the storage key", () => {
    const storage = memoryStorage();
    writeStoredBackendUrl(storage, "https://tunnel.example.com");
    expect(readStoredBackendUrl(storage)).toBe("https://tunnel.example.com");
    expect(storage.getItem(BACKEND_URL_STORAGE_KEY)).toBe("https://tunnel.example.com");
  });

  it("forgets on reset", () => {
    const storage = memoryStorage({
      [BACKEND_URL_STORAGE_KEY]: "https://tunnel.example.com",
    });
    clearStoredBackendUrl(storage);
    expect(readStoredBackendUrl(storage)).toBeNull();
  });

  it("reads null when storage refuses to answer", () => {
    const failing: BackendUrlStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readStoredBackendUrl(failing)).toBeNull();
  });

  it("still switches session-only when storage refuses the write", () => {
    const setItem = vi.fn(() => {
      throw new Error("denied");
    });
    const storage: BackendUrlStorage = { getItem: () => null, setItem, removeItem: () => {} };
    expect(() => writeStoredBackendUrl(storage, "https://tunnel.example.com")).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(
      BACKEND_URL_STORAGE_KEY,
      "https://tunnel.example.com",
    );
  });
});
