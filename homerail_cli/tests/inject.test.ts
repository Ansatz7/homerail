import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdInject } from "../src/commands/inject.js";
import type { HomeRailClient } from "../src/client.js";
afterEach(() => vi.restoreAllMocks());
describe("legacy inject receipt", () => {
  it.each([true, false])("fails even on HTTP success unless delivery is confirmed (success=%s)", async success => {
    const response = { success, message: "legacy response", data: { injected: false, delivered: false, delivery_gap: "unsupported" } };
    const client = { inject: vi.fn(async () => response) } as unknown as HomeRailClient;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await cmdInject(client, "run", "node", "feedback", "inbox", true)).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(response);
  });
});
