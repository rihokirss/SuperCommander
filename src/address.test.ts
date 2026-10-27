import { describe, expect, it } from "vitest";
import { formatRemoteAddress, parseRemoteAddress } from "./address";
describe("panel remote addresses", () => {
  it("opens both SSH and SFTP URLs with custom ports and decoded paths", () => {
    expect(
      parseRemoteAddress("sftp://alice@example.com:2222/home/alice/My%20files"),
    ).toEqual({
      host: "example.com",
      port: 2222,
      username: "alice",
      path: "/home/alice/My files",
    });
    expect(parseRemoteAddress("ssh://alice@example.com/var/www")).toEqual({
      host: "example.com",
      port: 22,
      username: "alice",
      path: "/var/www",
    });
  });
  it("supports scp-style addresses and IPv6", () => {
    expect(parseRemoteAddress("user@host:/srv/data")).toEqual({
      host: "host",
      port: 22,
      username: "user",
      path: "/srv/data",
    });
    expect(parseRemoteAddress("sftp://user@[::1]:2222/")).toEqual({
      host: "::1",
      port: 2222,
      username: "user",
      path: "/",
    });
  });
  it("leaves Windows, UNC and ordinary local paths alone", () => {
    for (const path of [
      "C:\\Users\\Alex",
      "C:/Users/Alex",
      "\\\\server\\share",
      "/home/alex",
    ])
      expect(parseRemoteAddress(path)).toBeNull();
  });
  it("rejects embedded passwords and invalid protocols or ports", () => {
    for (const address of [
      "ssh://user:secret@host/a",
      "sftp://host:99999/a",
      "sftp:///",
      "https://host/path",
    ])
      expect(() => parseRemoteAddress(address)).toThrow();
  });
  it("round-trips remote paths with spaces and reserved URI characters", () => {
    const profile = {
      id: "a",
      name: "Test",
      host: "::1",
      port: 2222,
      username: "alice",
      keyPath: "",
      saveSecret: false,
    };
    expect(
      parseRemoteAddress(
        formatRemoteAddress(profile, "/home/alice/#notes file.txt"),
      ),
    ).toEqual({
      host: "::1",
      port: 2222,
      username: "alice",
      path: "/home/alice/#notes file.txt",
    });
  });
});
