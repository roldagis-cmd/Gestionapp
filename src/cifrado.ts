import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM. Formato: base64(iv[12] | tag[16] | datos)
export function cifrar(texto: string, clave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", clave, iv);
  const datos = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), datos]).toString("base64");
}

export function descifrar(b64: string, clave: Buffer): string {
  const b = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", clave, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
