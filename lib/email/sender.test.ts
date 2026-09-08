import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const send = vi.fn<(payload: Record<string, unknown>) => Promise<unknown>>();
const construct = vi.fn<(key: string) => void>();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
    constructor(key: string) {
      construct(key);
    }
  },
}));

const { sendEmail, stripHeader, resetEmailClient } = await import("./sender");

let warn: ReturnType<typeof vi.spyOn>;

const ENV = { ...process.env };

beforeEach(() => {
  send.mockReset().mockResolvedValue({ data: { id: "eml_1" }, error: null });
  construct.mockReset();
  resetEmailClient();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Notifications <notify@example.co.uk>";
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  process.env = { ...ENV };
});

const message = {
  to: "owner@example.co.uk",
  subject: "A new enquiry",
  html: "<p>hello</p>",
  text: "hello",
};

describe("stripHeader", () => {
  it("removes CR and LF so a header field cannot inject another header", () => {
    expect(stripHeader("Enquiry\r\nBcc: attacker@example.com")).toBe(
      "Enquiry Bcc: attacker@example.com",
    );
    expect(stripHeader("a\nb\rc")).toBe("a b c");
  });

  it("collapses the whitespace the strip leaves behind and trims", () => {
    expect(stripHeader("  spaced \r\n\r\n out  ")).toBe("spaced out");
  });
});

describe("sendEmail", () => {
  it("sends through Resend and reports the message id", async () => {
    const result = await sendEmail({ ...message, replyTo: "sam@example.co.uk" });

    expect(result).toEqual({ sent: true, id: "eml_1" });
    expect(construct).toHaveBeenCalledWith("re_test");
    expect(send).toHaveBeenCalledWith({
      from: "Notifications <notify@example.co.uk>",
      to: ["owner@example.co.uk"],
      subject: "A new enquiry",
      html: "<p>hello</p>",
      text: "hello",
      replyTo: "sam@example.co.uk",
    });
  });

  it("strips CR/LF from every header field", async () => {
    await sendEmail({
      to: "owner@example.co.uk\r\nBcc: attacker@example.com",
      subject: "Hi\nX-Evil: 1",
      html: "<p>body\r\nkept</p>",
      text: "body\r\nkept",
      replyTo: "sam@example.co.uk\rBcc: attacker@example.com",
    });

    const payload = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.to).toEqual(["owner@example.co.uk Bcc: attacker@example.com"]);
    expect(payload.subject).toBe("Hi X-Evil: 1");
    expect(payload.replyTo).toBe("sam@example.co.uk Bcc: attacker@example.com");
    // The body is not a header. Its newlines are content and must survive.
    expect(payload.text).toBe("body\r\nkept");
  });

  it("reports not-configured and sends nothing when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    resetEmailClient();

    expect(await sendEmail(message)).toEqual({ sent: false, reason: "not-configured" });
    expect(send).not.toHaveBeenCalled();
    // A silent no-op is how a site ships with nobody noticing mail is dead.
    expect(warn).toHaveBeenCalled();
  });

  it("reports not-configured when EMAIL_FROM is unset", async () => {
    delete process.env.EMAIL_FROM;
    resetEmailClient();

    expect(await sendEmail(message)).toEqual({ sent: false, reason: "not-configured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports no-recipient rather than calling Resend with an empty address list", async () => {
    expect(await sendEmail({ ...message, to: ["", "   "] })).toEqual({
      sent: false,
      reason: "no-recipient",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the provider's error instead of throwing", async () => {
    send.mockResolvedValue({ data: null, error: { message: "domain not verified", name: "validation_error", statusCode: 403 } });

    expect(await sendEmail(message)).toEqual({
      sent: false,
      reason: "rejected",
      error: "domain not verified",
    });
  });

  it("never throws when the transport itself fails", async () => {
    send.mockRejectedValue(new Error("ECONNRESET"));

    expect(await sendEmail(message)).toEqual({
      sent: false,
      reason: "rejected",
      error: "ECONNRESET",
    });
  });
});
