import { describe, it, expect } from "vitest";
import {
  isValidSSHHost,
  isValidSSHUsername,
  isValidSSHPort,
  validateSSHParams,
  escapeShellArg,
} from "@/lib/ssh-validation";

/**
 * These validators are the command-injection guard in front of SSH spawn()
 * calls, so the negative cases (shell metacharacters, spaces) matter as much as
 * the positive ones.
 */
describe("isValidSSHHost", () => {
  it("accepts hostnames, IPv4 and IPv6", () => {
    expect(isValidSSHHost("example.com")).toBe(true);
    expect(isValidSSHHost("dash.packet.ai")).toBe(true);
    expect(isValidSSHHost("192.168.1.1")).toBe(true);
    expect(isValidSSHHost("[::1]")).toBe(true);
    expect(isValidSSHHost("fe80::1")).toBe(true);
    expect(isValidSSHHost("localhost")).toBe(true);
  });

  it("rejects empty, non-string and over-long hosts", () => {
    expect(isValidSSHHost("")).toBe(false);
    // @ts-expect-error — guarding the runtime non-string path
    expect(isValidSSHHost(null)).toBe(false);
    expect(isValidSSHHost("a".repeat(254))).toBe(false);
  });

  it("rejects shell-injection metacharacters and spaces", () => {
    expect(isValidSSHHost("host name")).toBe(false);
    expect(isValidSSHHost("host;rm -rf /")).toBe(false);
    expect(isValidSSHHost("host$(whoami)")).toBe(false);
    expect(isValidSSHHost("host|cat")).toBe(false);
  });
});

describe("isValidSSHUsername", () => {
  it("accepts standard Unix usernames", () => {
    expect(isValidSSHUsername("root")).toBe(true);
    expect(isValidSSHUsername("ubuntu")).toBe(true);
    expect(isValidSSHUsername("user_name")).toBe(true);
    expect(isValidSSHUsername("_svc")).toBe(true);
    expect(isValidSSHUsername("a-b")).toBe(true);
  });

  it("rejects bad starts, bad chars, and over-long names", () => {
    expect(isValidSSHUsername("")).toBe(false);
    expect(isValidSSHUsername("1user")).toBe(false); // must start letter/underscore
    expect(isValidSSHUsername("-user")).toBe(false);
    expect(isValidSSHUsername("user name")).toBe(false);
    expect(isValidSSHUsername("user;rm")).toBe(false);
    expect(isValidSSHUsername("a".repeat(33))).toBe(false);
  });
});

describe("isValidSSHPort", () => {
  it("accepts in-range numbers and numeric strings", () => {
    expect(isValidSSHPort(22)).toBe(true);
    expect(isValidSSHPort(1)).toBe(true);
    expect(isValidSSHPort(65535)).toBe(true);
    expect(isValidSSHPort("22")).toBe(true);
    expect(isValidSSHPort("8080")).toBe(true);
  });

  it("rejects out-of-range, non-integer and non-numeric ports", () => {
    expect(isValidSSHPort(0)).toBe(false);
    expect(isValidSSHPort(-1)).toBe(false);
    expect(isValidSSHPort(65536)).toBe(false);
    expect(isValidSSHPort(22.5)).toBe(false);
    expect(isValidSSHPort("notaport")).toBe(false);
  });
});

describe("validateSSHParams", () => {
  const valid = { host: "example.com", port: 22, username: "ubuntu" };

  it("does not throw for valid params", () => {
    expect(() => validateSSHParams(valid)).not.toThrow();
  });

  it("throws a descriptive error per invalid field", () => {
    expect(() => validateSSHParams({ ...valid, host: "bad host" })).toThrow(
      /Invalid SSH host/,
    );
    expect(() => validateSSHParams({ ...valid, port: 0 })).toThrow(
      /Invalid SSH port/,
    );
    expect(() => validateSSHParams({ ...valid, username: "1bad" })).toThrow(
      /Invalid SSH username/,
    );
  });
});

describe("escapeShellArg", () => {
  it("wraps plain args in single quotes", () => {
    expect(escapeShellArg("hello")).toBe("'hello'");
    expect(escapeShellArg("a;b|c")).toBe("'a;b|c'"); // metachars are inert inside quotes
  });

  it("escapes embedded single quotes", () => {
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
  });
});
