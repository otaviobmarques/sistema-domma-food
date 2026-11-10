import { test } from "node:test";
import assert from "node:assert/strict";
import { crc16, pixPayload } from "./pix.ts";
import { parseBRL, formatPhone, slugify } from "./format.ts";

test("CRC16-CCITT conhecido", () => {
  assert.equal(crc16("123456789"), "29B1");
});

test("payload Pix tem estrutura e CRC válidos", () => {
  const p = pixPayload({ key: "pix@bella.com", name: "Bella Massa Pizzaria Ltda Extra", city: "Belo Horizonte", amountCents: 9242, txid: "DF4821" });
  assert.ok(p.startsWith("000201"));
  assert.ok(p.includes("0014br.gov.bcb.pix0113pix@bella.com"));
  assert.ok(p.includes("540592.42"));
  assert.ok(p.includes("5925BELLA MASSA PIZZARIA LTD"));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
});

test("formatadores", () => {
  assert.equal(parseBRL("29,90"), 2990);
  assert.equal(parseBRL("1.234,50"), 123450);
  assert.equal(formatPhone("31988771122"), "(31) 98877-1122");
  assert.equal(slugify("Bella Massa Pizzária!"), "bella-massa-pizzaria");
});
