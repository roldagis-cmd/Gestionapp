import type { FetchLike } from "./arca/soap.js";

/** Envío de emails. En producción usa la API de Brevo (plan gratuito: 300 emails por día). */
export interface Correo { enviar(para: string, asunto: string, texto: string, html: string): Promise<void> }

export class CorreoError extends Error {}

export function correoBrevo(apiKey: string, remitente: string, fetchFn: FetchLike = fetch as FetchLike): Correo {
  return {
    async enviar(para, asunto, texto, html) {
      const r = await fetchFn("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender: { name: "GESTIONAPP", email: remitente }, to: [{ email: para }], subject: asunto, textContent: texto, htmlContent: html }),
      });
      if (!r.ok) throw new CorreoError(`Brevo respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
    },
  };
}

/** Para desarrollo sin servicio de email: muestra el mensaje en la consola del servidor. */
export const correoConsola: Correo = {
  async enviar(para, asunto, texto) { console.log(`[email a ${para}] ${asunto}\n${texto}`); },
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function mensajeCodigo(codigo: string) {
  const asunto = `${codigo} es tu código para entrar a GESTIONAPP`;
  const texto = `Tu código para entrar a GESTIONAPP es ${codigo}.\n\nVence en 10 minutos. Si no lo pediste, ignorá este email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;color:#1d1630">
<p style="font-size:15px">Tu código para entrar a <b>GESTIONAPP</b> es:</p>
<p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:16px 0;color:#6c4cc4">${esc(codigo)}</p>
<p style="font-size:13px;color:#665d7a">Vence en 10 minutos. Si no lo pediste, ignorá este email.</p></div>`;
  return { asunto, texto, html };
}

export function mensajeInvitacion(empresa: string, url: string) {
  const asunto = `Te dieron acceso a ${empresa} en GESTIONAPP`;
  const texto = `Te dieron acceso a ${empresa} en GESTIONAPP.\n\nEntrá en ${url} con este email: te vamos a mandar un código de 6 dígitos para ingresar.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;color:#1d1630">
<p style="font-size:15px">Te dieron acceso a <b>${esc(empresa)}</b> en GESTIONAPP.</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#6c4cc4;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Entrar a GESTIONAPP</a></p>
<p style="font-size:13px;color:#665d7a">Ingresás con este email: te mandamos un código de 6 dígitos cada vez.</p></div>`;
  return { asunto, texto, html };
}
