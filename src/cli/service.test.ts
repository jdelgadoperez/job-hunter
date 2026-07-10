import { describe, expect, it } from "vitest";
import { isServiceAction, resolveServiceInvocation, SERVICE_ACTIONS } from "./service";

describe("isServiceAction", () => {
  it("accepts every documented action and rejects others", () => {
    for (const action of SERVICE_ACTIONS) {
      expect(isServiceAction(action)).toBe(true);
    }
    for (const other of ["reload", "", "INSTALL"]) {
      expect(isServiceAction(other)).toBe(false);
    }
  });
});

describe("resolveServiceInvocation", () => {
  const repo = "/home/u/job-hunter";

  it("runs the .sh script directly on macOS/Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(resolveServiceInvocation("install", platform, repo)).toEqual({
        command: "/home/u/job-hunter/service-install.sh",
        args: [],
      });
    }
  });

  it("maps each action to its matching script name", () => {
    for (const action of SERVICE_ACTIONS) {
      const { command } = resolveServiceInvocation(action, "darwin", repo);
      expect(command).toBe(`/home/u/job-hunter/service-${action}.sh`);
    }
  });

  it("runs the .ps1 script via powershell (bypassing execution policy) on Windows", () => {
    const invocation = resolveServiceInvocation("status", "win32", "C:\\jh");
    expect(invocation.command).toBe("powershell");
    // Unsigned scripts need an explicit bypass, and -File targets the resolved .ps1.
    expect(invocation.args).toContain("-ExecutionPolicy");
    expect(invocation.args).toContain("Bypass");
    expect(invocation.args[invocation.args.length - 1]).toMatch(/service-status\.ps1$/);
  });
});

describe("service argument-injection invariants (10.1)", () => {
  it("rejects any action outside the fixed allow-list before it reaches spawn", () => {
    expect(isServiceAction("install; rm -rf /")).toBe(false);
    expect(isServiceAction("--version")).toBe(false);
    for (const action of SERVICE_ACTIONS) {
      expect(isServiceAction(action)).toBe(true);
    }
  });

  it("passes the script path as an array arg, never a shell string, on posix", () => {
    const invocation = resolveServiceInvocation("start", "linux", "/repo");
    expect(Array.isArray(invocation.args)).toBe(true);
    expect(invocation.command).toContain("service-start.sh");
    expect(invocation.command).not.toContain(" ");
  });

  it("passes the script via -File as a discrete arg on win32", () => {
    const invocation = resolveServiceInvocation("stop", "win32", "C:/repo");
    expect(invocation.command).toBe("powershell");
    expect(invocation.args).toContain("-File");
    const fileIndex = invocation.args.indexOf("-File");
    expect(invocation.args[fileIndex + 1]).toContain("service-stop.ps1");
  });
});
