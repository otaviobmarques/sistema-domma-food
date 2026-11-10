// Gera o "Pix copia e cola" (BR Code estático, padrão EMV do Banco Central).
const tlv = (id: string, value: string) => id + value.length.toString().padStart(2, "0") + value;

const clean = (s: string, max: number) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]/g, "")
    .toUpperCase().trim().slice(0, max);

export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function pixPayload(o: { key: string; name: string; city: string; amountCents: number; txid?: string }) {
  const account = tlv("00", "br.gov.bcb.pix") + tlv("01", o.key.trim());
  const txid = (o.txid ?? "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const body =
    tlv("00", "01") +
    tlv("26", account) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", (o.amountCents / 100).toFixed(2)) +
    tlv("58", "BR") +
    tlv("59", clean(o.name, 25) || "LOJA") +
    tlv("60", clean(o.city, 15) || "BRASIL") +
    tlv("62", tlv("05", txid)) +
    "6304";
  return body + crc16(body);
}
