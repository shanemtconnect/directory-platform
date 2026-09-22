import { describe, it, expect } from "vitest";
import { QUOTE_MESSAGE_MAX, validateQuoteRequest } from "./quotes-validation";

const CITY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const good = {
  cityId: CITY,
  categoryId: CATEGORY,
  name: "Sam Requester",
  email: "sam@example.co.uk",
  phone: "",
  message: "Eighty people in June,\r\nwith parking.",
  consent: "on",
};

describe("validateQuoteRequest", () => {
  it("accepts a complete form, normalising the body and nulling an empty phone", () => {
    const { values, errors } = validateQuoteRequest(form(good));
    expect(errors).toBeUndefined();
    expect(values).toEqual({
      cityId: CITY,
      categoryId: CATEGORY,
      name: "Sam Requester",
      email: "sam@example.co.uk",
      phone: null,
      message: "Eighty people in June,\nwith parking.",
    });
  });

  it("requires the consent box", () => {
    const { errors } = validateQuoteRequest(form({ ...good, consent: "" }));
    expect(errors?.consent).toBeTruthy();
  });

  it("rejects a tampered town or category id", () => {
    const { errors } = validateQuoteRequest(form({ ...good, cityId: "leeds", categoryId: "1 or 1=1" }));
    expect(errors?.cityId).toBeTruthy();
    expect(errors?.categoryId).toBeTruthy();
  });

  it("caps the job at 1000 characters and floors it at 10", () => {
    expect(validateQuoteRequest(form({ ...good, message: "x".repeat(QUOTE_MESSAGE_MAX + 1) })).errors?.message).toContain("1000");
    expect(validateQuoteRequest(form({ ...good, message: "x".repeat(QUOTE_MESSAGE_MAX) })).errors).toBeUndefined();
    expect(validateQuoteRequest(form({ ...good, message: "too short" })).errors?.message).toBeTruthy();
  });

  it("strips CR/LF from the header-bound fields", () => {
    const { values } = validateQuoteRequest(form({ ...good, name: "Sam\r\nBcc: x@y.z", phone: "0163\n2" }));
    expect(values?.name).toBe("Sam Bcc: x@y.z");
    expect(values?.phone).toBe("0163 2");
  });

  it("rejects a malformed address and an empty name", () => {
    const { errors } = validateQuoteRequest(form({ ...good, email: "not-an-address", name: "S" }));
    expect(errors?.email).toBeTruthy();
    expect(errors?.name).toBeTruthy();
  });
});
