import { describe, expect, it } from "vitest";
import { networkKey, networkLocations, networkPath } from "./network";
const detected = [
  { name: "Explorer server", path: "\\\\server", kind: "network" },
  { name: "Share", path: "\\\\server\\share", kind: "network" },
];
describe("network catalog", () => {
  it("keeps saved names over Explorer entries and respects hidden imports", () => {
    expect(
      networkLocations(
        {
          networkLocations: [
            { name: "My server", path: "\\\\SERVER\\", kind: "network" },
          ],
          hiddenNetworkPaths: ["\\\\server\\share"],
        },
        detected,
      ).map((p) => p.name),
    ).toEqual(["My server"]);
    expect(networkKey("//SERVER/share/")).toBe(networkKey("\\\\server\\share"));
  });
  it("accepts servers, shares and mapped drives but rejects ambiguous paths", () => {
    for (const path of [
      "\\\\ketas",
      "\\\\itk-server\\share",
      "//server/share/folder",
      "Z:\\folder",
    ])
      expect(networkPath(path)).not.toBeNull();
    for (const path of [
      "server",
      "\\\\server\\..\\share",
      "\\\\server\\share?",
      "\\\\bad\nname",
      "\\\\?\\C:\\",
    ])
      expect(networkPath(path)).toBeNull();
  });
});
