import { describe, expect, it } from "vitest";

import {
  createConnStore,
  INITIAL_CONN_STATE,
  selectOverride,
  setOverride,
} from "@/stores/conn";

/**
 * The debug override's standing selection, and its one writer.
 *
 * `override` is the user's intent kept beside the backend's answer — never
 * in place of it — so the interesting promise is narrow: recording a selection
 * touches nothing else in the connection state, and clearing it hands the
 * decision back. Both `WsClient.forceTier` and the pre-effect branch of
 * `useMarketStream`'s `forceTier` go through `setOverride`, which is what
 * keeps the intent from being written two different ways.
 */

describe("conn store override", () => {
  it("starts with the backend's decision standing", () => {
    const store = createConnStore();

    expect(store.getState()).toEqual(INITIAL_CONN_STATE);
    expect(selectOverride(store.getState())).toBeNull();
  });

  it("records the user's selection and nothing else", () => {
    const store = createConnStore();

    setOverride(store, "minimal");

    expect(selectOverride(store.getState())).toBe("minimal");
    expect(store.getState()).toMatchObject({ ...INITIAL_CONN_STATE, override: "minimal" });
  });

  it("hands the decision back when cleared", () => {
    const store = createConnStore();
    setOverride(store, "degraded");

    setOverride(store, null);

    expect(selectOverride(store.getState())).toBeNull();
    expect(store.getState()).toEqual(INITIAL_CONN_STATE);
  });
});
