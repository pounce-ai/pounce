/**
 * `fmtBytes`, whose two edges both mislead if they're wrong: a folder shown as
 * "0 B" invites deleting it, and a folder shown as "—" must never be one we
 * actually measured.
 */
import { describe, expect, it } from "vitest";
import { fmtBytes } from "./format";

describe("fmtBytes", () => {
  it("scales to the unit a person would use, base 1024 like du", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(24.1 * 1024 * 1024)).toBe("24 MB");
    expect(fmtBytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
    expect(fmtBytes(19.64 * 1024 ** 3)).toBe("19.6 GB");
    expect(fmtBytes(2 * 1024 ** 4)).toBe("2 TB");
  });

  it("keeps a decimal only where it changes the reading", () => {
    // Gigabytes are where a tenth is a real amount of disk; megabytes aren't.
    expect(fmtBytes(847.3 * 1024 * 1024)).toBe("847 MB");
    expect(fmtBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    // …and past 100 of a unit it stops being worth the character.
    expect(fmtBytes(120.7 * 1024 ** 3)).toBe("121 GB");
  });

  it("distinguishes 'nothing there' from 'we could not measure it'", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(undefined)).toBe("—");
    expect(fmtBytes(Number.NaN)).toBe("—");
  });
});
