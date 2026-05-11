import { describe, it, expect } from "vitest";
import {
  COMMIT_TYPES,
  SUBJECT_MAX_LEN,
  validateSubject,
  validateCommit,
  formatCommitMessage,
} from "./snap.js";

describe("validateSubject", () => {
  it("accepts a clean lowercase subject", () => {
    const r = validateSubject("add password strength check to signup");
    expect(r).toEqual({ ok: true, subject: "add password strength check to signup" });
  });

  it("trims surrounding whitespace", () => {
    const r = validateSubject("  fix null email  ");
    expect(r).toEqual({ ok: true, subject: "fix null email" });
  });

  it("rejects empty", () => {
    expect(validateSubject("")).toMatchObject({ ok: false });
    expect(validateSubject("   ")).toMatchObject({ ok: false });
  });

  it(`rejects subjects longer than ${SUBJECT_MAX_LEN} chars`, () => {
    const tooLong = "a".repeat(SUBJECT_MAX_LEN + 1);
    const r = validateSubject(tooLong);
    expect(r.ok).toBe(false);
  });

  it(`accepts subjects at exactly ${SUBJECT_MAX_LEN} chars`, () => {
    const exact = "a".repeat(SUBJECT_MAX_LEN);
    const r = validateSubject(exact);
    expect(r.ok).toBe(true);
  });

  it("rejects subjects with uppercase letters", () => {
    expect(validateSubject("Add password check").ok).toBe(false);
    expect(validateSubject("fix JSON parser").ok).toBe(false);
  });

  it("rejects subjects ending with a period", () => {
    expect(validateSubject("add tests.").ok).toBe(false);
  });

  it("rejects multi-line subjects", () => {
    expect(validateSubject("add tests\nand fix bug").ok).toBe(false);
    expect(validateSubject("add tests\r\nand fix bug").ok).toBe(false);
  });

  it("allows periods mid-subject (e.g., version numbers)", () => {
    const r = validateSubject("bump next to 14.2.3");
    expect(r).toEqual({ ok: true, subject: "bump next to 14.2.3" });
  });

  it("allows non-letter punctuation like slashes and @", () => {
    const r = validateSubject("bump @types/node to 22");
    expect(r.ok).toBe(true);
  });
});

describe("validateCommit", () => {
  it("accepts a clean commit", () => {
    const r = validateCommit({
      type: "feat",
      subject: "add password strength check",
    });
    expect(r).toEqual({ ok: true, subject: "add password strength check", body: null });
  });

  it("rejects an unknown type", () => {
    const r = validateCommit({ type: "feature", subject: "ok" });
    expect(r.ok).toBe(false);
  });

  it("accepts every spec-listed type", () => {
    for (const type of COMMIT_TYPES) {
      const r = validateCommit({ type, subject: "do a thing" });
      expect(r.ok, `${type} should validate`).toBe(true);
    }
  });

  it("treats empty body as no body", () => {
    const r = validateCommit({ type: "fix", subject: "do a thing", body: "" });
    expect(r).toEqual({ ok: true, subject: "do a thing", body: null });
  });

  it("treats whitespace-only body as no body", () => {
    const r = validateCommit({
      type: "fix",
      subject: "do a thing",
      body: "   \n  ",
    });
    expect(r).toEqual({ ok: true, subject: "do a thing", body: null });
  });

  it("keeps a real body and trims it", () => {
    const r = validateCommit({
      type: "fix",
      subject: "handle null email",
      body: "\n  social login sometimes omits email; default to placeholder.\n",
    });
    expect(r).toEqual({
      ok: true,
      subject: "handle null email",
      body: "social login sometimes omits email; default to placeholder.",
    });
  });

  it("propagates subject errors", () => {
    const r = validateCommit({ type: "fix", subject: "Bad Subject" });
    expect(r.ok).toBe(false);
  });
});

describe("formatCommitMessage", () => {
  it("produces 'type: subject' with no body", () => {
    expect(formatCommitMessage("feat", "add login", null)).toBe("feat: add login");
  });

  it("appends body separated by a blank line", () => {
    expect(formatCommitMessage("fix", "handle null email", "social login omits it")).toBe(
      "fix: handle null email\n\nsocial login omits it",
    );
  });
});
