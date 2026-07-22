import { describe, expect, it } from "vitest";
import { installedCardState, installedCardStateLabel } from "./installedCardState";

describe("installed agent card state", () => {
  it("uses the simple setup journey labels", () => {
    expect(installedCardStateLabel(installedCardState("installed", "probing"))).toBe("Getting agent ready");
    expect(installedCardStateLabel(installedCardState("installed", "ready"))).toBe("Ready to use");
    expect(installedCardStateLabel(installedCardState("installed", "authentication_required"))).toBe("Sign-in required");
    expect(installedCardStateLabel(installedCardState("installed", "failed"))).toBe("Setup needed");
    expect(installedCardStateLabel(installedCardState("installed", "authentication_required", "authenticating"))).toBe("Signing in");
  });
});
