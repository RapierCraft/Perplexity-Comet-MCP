/**
 * Unit tests for validateUploadPath() in src/upload-validator.ts.
 *
 * Uses vi.mock to stub out `fs` and `os` so tests run portably on macOS,
 * Windows, and Linux CI — independent of whether /proc or /home exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports of the module
// ---------------------------------------------------------------------------

const mockRealpathSync = vi.fn<[string], string>();
const mockStatSync = vi.fn();
const mockHomedir = vi.fn(() => "/home/testuser");

vi.mock("fs", () => ({
  realpathSync: mockRealpathSync,
  statSync: mockStatSync,
}));

vi.mock("os", () => ({
  homedir: mockHomedir,
}));

// Import after mocks are registered
const { validateUploadPath } = await import("../../src/upload-validator.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure mocks for a "normal file" at the given real path. */
function mockFile(realPath: string): void {
  mockRealpathSync.mockReturnValue(realPath);
  mockStatSync.mockReturnValue({ isFile: () => true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateUploadPath — /proc subtree blocking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue("/home/testuser");
    delete process.env.COMET_UPLOAD_ROOT;
  });

  it("blocks /proc/self/environ", () => {
    mockFile("/proc/self/environ");
    expect(() => validateUploadPath("/proc/self/environ")).toThrow(
      /sensitive path/,
    );
  });

  it("blocks /proc/self/maps", () => {
    mockFile("/proc/self/maps");
    expect(() => validateUploadPath("/proc/self/maps")).toThrow(
      /sensitive path/,
    );
  });

  it("blocks /proc/self/fd/0", () => {
    mockFile("/proc/self/fd/0");
    expect(() => validateUploadPath("/proc/self/fd/0")).toThrow(
      /sensitive path/,
    );
  });

  it("blocks /proc/1/environ (root process)", () => {
    mockFile("/proc/1/environ");
    expect(() => validateUploadPath("/proc/1/environ")).toThrow(
      /sensitive path/,
    );
  });

  it("blocks /proc/12345/mem (arbitrary PID memory)", () => {
    mockFile("/proc/12345/mem");
    expect(() => validateUploadPath("/proc/12345/mem")).toThrow(
      /sensitive path/,
    );
  });

  it("blocks the /proc mount point itself if it ever resolves as a file", () => {
    // /proc as an exact match (real === prefix)
    mockFile("/proc");
    expect(() => validateUploadPath("/proc")).toThrow(/sensitive path/);
  });
});

describe("validateUploadPath — home-dir sensitive path blocking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue("/home/testuser");
    delete process.env.COMET_UPLOAD_ROOT;
  });

  it("blocks ~/.ssh/id_rsa", () => {
    mockFile("/home/testuser/.ssh/id_rsa");
    expect(() => validateUploadPath("~/.ssh/id_rsa")).toThrow(/sensitive path/);
  });

  it("blocks ~/.aws/credentials", () => {
    mockFile("/home/testuser/.aws/credentials");
    expect(() => validateUploadPath("~/.aws/credentials")).toThrow(
      /sensitive path/,
    );
  });

  it("blocks /etc/shadow", () => {
    mockFile("/etc/shadow");
    expect(() => validateUploadPath("/etc/shadow")).toThrow(/sensitive path/);
  });

  it("blocks /root/secret.txt (under /root)", () => {
    mockFile("/root/secret.txt");
    expect(() => validateUploadPath("/root/secret.txt")).toThrow(
      /sensitive path/,
    );
  });
});

describe("validateUploadPath — .env file blocking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue("/home/testuser");
    delete process.env.COMET_UPLOAD_ROOT;
  });

  it("blocks .env at home root", () => {
    mockFile("/home/testuser/.env");
    expect(() => validateUploadPath("~/.env")).toThrow(/sensitive path/);
  });

  it("blocks .env.production anywhere on the filesystem", () => {
    mockFile("/var/app/.env.production");
    expect(() => validateUploadPath("/var/app/.env.production")).toThrow(
      /environment file/,
    );
  });
});

describe("validateUploadPath — valid paths (no COMET_UPLOAD_ROOT)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue("/home/testuser");
    delete process.env.COMET_UPLOAD_ROOT;
  });

  it("allows a regular file under /tmp", () => {
    mockFile("/tmp/document.pdf");
    const result = validateUploadPath("/tmp/document.pdf");
    expect(result).toBe("/tmp/document.pdf");
  });

  it("allows a regular file under /home/testuser/uploads", () => {
    mockFile("/home/testuser/uploads/photo.jpg");
    const result = validateUploadPath("/home/testuser/uploads/photo.jpg");
    expect(result).toBe("/home/testuser/uploads/photo.jpg");
  });
});

describe("validateUploadPath — COMET_UPLOAD_ROOT allowlist", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue("/home/testuser");
  });

  afterEach(() => {
    delete process.env.COMET_UPLOAD_ROOT;
  });

  it("allows a path inside COMET_UPLOAD_ROOT", () => {
    process.env.COMET_UPLOAD_ROOT = "/home/testuser/uploads";
    mockRealpathSync
      .mockReturnValueOnce("/home/testuser/uploads/file.txt") // resolves filePath
      .mockReturnValueOnce("/home/testuser/uploads"); // resolves root
    mockStatSync.mockReturnValue({ isFile: () => true });

    const result = validateUploadPath("/home/testuser/uploads/file.txt");
    expect(result).toBe("/home/testuser/uploads/file.txt");
  });

  it("rejects a path outside COMET_UPLOAD_ROOT", () => {
    process.env.COMET_UPLOAD_ROOT = "/home/testuser/uploads";
    mockRealpathSync
      .mockReturnValueOnce("/etc/passwd") // resolves filePath
      .mockReturnValueOnce("/home/testuser/uploads"); // resolves root
    mockStatSync.mockReturnValue({ isFile: () => true });

    expect(() => validateUploadPath("/etc/passwd")).toThrow(
      /outside COMET_UPLOAD_ROOT/,
    );
  });

  it("rejects COMET_UPLOAD_ROOT set to /", () => {
    process.env.COMET_UPLOAD_ROOT = "/";
    mockFile("/tmp/file.txt");

    expect(() => validateUploadPath("/tmp/file.txt")).toThrow(/overly broad/);
  });
});

describe("validateUploadPath — error cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue("/home/testuser");
    delete process.env.COMET_UPLOAD_ROOT;
  });

  it("throws File not found for ENOENT", () => {
    mockRealpathSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    });

    expect(() => validateUploadPath("/nonexistent/file.txt")).toThrow(
      /File not found/,
    );
  });

  it("throws Not a regular file for directories", () => {
    mockRealpathSync.mockReturnValue("/tmp/somedir");
    mockStatSync.mockReturnValue({ isFile: () => false });

    expect(() => validateUploadPath("/tmp/somedir")).toThrow(
      /Not a regular file/,
    );
  });
});
