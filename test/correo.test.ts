import { describe, it, expect } from "vitest";
import { correoBrevo, mensajeCodigo, CorreoError } from "../src/correo.js";

describe("correo", () => {
  it("envía por la API de Brevo con el remitente configurado", async () => {
    const pedidos: any[] = [];
    const c = correoBrevo("clave-api", "avisos@gestionapp.com.ar", async (url, init) => { pedidos.push({ url, init }); return { ok: true, status: 201, text: async () => "{}" }; });
    const m = mensajeCodigo("042317");
    await c.enviar("gisela@example.com", m.asunto, m.texto, m.html);
    expect(pedidos[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(pedidos[0].init.headers["api-key"]).toBe("clave-api");
    const body = JSON.parse(pedidos[0].init.body);
    expect(body).toMatchObject({ sender: { email: "avisos@gestionapp.com.ar" }, to: [{ email: "gisela@example.com" }], subject: "042317 es tu código para entrar a GESTIONAPP" });
    expect(body.htmlContent).toContain("042317");
  });
  it("informa el error si Brevo rechaza el envío", async () => {
    const c = correoBrevo("k", "a@b.com", async () => ({ ok: false, status: 401, text: async () => "key not found" }));
    await expect(c.enviar("x@y.com", "a", "b", "c")).rejects.toBeInstanceOf(CorreoError);
  });
});
