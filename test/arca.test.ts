import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { armarTRA, firmarTRA, loginCms } from "../src/arca/wsaa.js";
import { armarFECAESolicitar, solicitarCAE, ultimoAutorizado } from "../src/arca/wsfe.js";
import { ArcaError } from "../src/arca/soap.js";
import { certificadoDePrueba, arcaFalsa } from "./ayuda.js";

const { certPem, keyPem } = certificadoDePrueba();
const auth = { token: "T", sign: "S", cuit: "20-12345678-6" };

describe("WSAA", () => {
  it("arma el TRA con una ventana de 10 minutos", () => {
    const tra = armarTRA("wsfe", new Date("2026-11-25T12:00:00Z"));
    expect(tra).toContain("<service>wsfe</service>");
    expect(tra).toContain("<generationTime>2026-11-25T11:50:00Z</generationTime>");
    expect(tra).toContain("<expirationTime>2026-11-25T12:10:00Z</expirationTime>");
  });

  it("firma un CMS que OpenSSL verifica y que incluye el TRA", () => {
    const tra = armarTRA("wsfe");
    const cms = firmarTRA(tra, certPem, keyPem);
    const dir = mkdtempSync(path.join(tmpdir(), "cms-"));
    writeFileSync(path.join(dir, "f.der"), Buffer.from(cms, "base64"));
    const out = execFileSync("openssl", ["cms", "-verify", "-noverify", "-inform", "DER", "-in", path.join(dir, "f.der")], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    expect(out).toBe(tra);
  });

  it("avisa en castellano si el certificado no es PEM", () => {
    expect(() => firmarTRA("x", "no es un cert", keyPem)).toThrow(/certificado no es válido/);
  });

  it("lee token, sign y vencimiento de la respuesta", async () => {
    const { fn, pedidos } = arcaFalsa();
    const c = await loginCms(fn, "homologacion", "CMSBASE64");
    expect(c.token).toBe("TOKEN123");
    expect(c.sign).toBe("SIGN456");
    expect(pedidos[0].url).toContain("wsaahomo");
    expect(pedidos[0].body).toContain("<wsaa:in0>CMSBASE64</wsaa:in0>");
  });
});

describe("WSFEv1", () => {
  it("arma una Factura C a consumidor final sin IVA discriminado", () => {
    const xml = armarFECAESolicitar(auth, { cbteTipo: 11, puntoVenta: 2, numero: 42, fecha: "2026-11-25", concepto: 1, docTipo: 99, docNro: "", condicionIva: 5, total: 1500.5 });
    expect(xml).toContain("<ar:Cuit>20123456786</ar:Cuit>");
    expect(xml).toContain("<ar:CbteTipo>11</ar:CbteTipo>");
    expect(xml).toContain("<ar:DocNro>0</ar:DocNro>");
    expect(xml).toContain("<ar:CbteFch>20261125</ar:CbteFch>");
    expect(xml).toContain("<ar:ImpTotal>1500.50</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>1500.50</ar:ImpNeto>");
    expect(xml).toContain("<ar:ImpIVA>0.00</ar:ImpIVA>");
    expect(xml).toContain("<ar:CondicionIVAReceptorId>5</ar:CondicionIVAReceptorId>");
    expect(xml).not.toContain("FchServDesde");
  });

  it("agrega fechas de servicio y comprobante asociado cuando corresponde", () => {
    const xml = armarFECAESolicitar(auth, { cbteTipo: 13, puntoVenta: 2, numero: 5, fecha: "2026-11-25", concepto: 2, docTipo: 80, docNro: "30-71234567-8", condicionIva: 1, total: 100, asociado: { tipo: 11, puntoVenta: 2, numero: 40, fecha: "2026-11-01" } });
    expect(xml).toContain("<ar:DocNro>30712345678</ar:DocNro>");
    expect(xml).toContain("<ar:FchServDesde>20261125</ar:FchServDesde>");
    expect(xml).toContain("<ar:CbteAsoc><ar:Tipo>11</ar:Tipo><ar:PtoVta>2</ar:PtoVta><ar:Nro>40</ar:Nro><ar:CbteFch>20261101</ar:CbteFch></ar:CbteAsoc>");
  });

  it("devuelve el CAE de una respuesta aprobada", async () => {
    const { fn } = arcaFalsa();
    expect(await ultimoAutorizado(fn, "homologacion", auth, 2, 11)).toBe(41);
    const r = await solicitarCAE(fn, "homologacion", auth, { cbteTipo: 11, puntoVenta: 2, numero: 42, fecha: "2026-11-25", concepto: 1, docTipo: 99, docNro: "", condicionIva: 5, total: 10 });
    expect(r).toMatchObject({ resultado: "A", cae: "76123456789012", caeVto: "2026-12-05", numero: 42 });
  });

  it("explica el rechazo con los códigos de ARCA", async () => {
    const { fn } = arcaFalsa({ rechazar: true });
    await expect(solicitarCAE(fn, "homologacion", auth, { cbteTipo: 11, puntoVenta: 2, numero: 42, fecha: "2026-11-25", concepto: 1, docTipo: 99, docNro: "", condicionIva: 5, total: 10 }))
      .rejects.toThrow(/10016: Numero incorrecto \| 10015: DocNro invalido/);
  });

  it("traduce un SOAP Fault a ArcaError", async () => {
    const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>x</faultcode><faultstring>Servicio caido</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    const fn = async () => ({ ok: false, status: 500, text: async () => fault });
    await expect(ultimoAutorizado(fn, "homologacion", auth, 1, 11)).rejects.toBeInstanceOf(ArcaError);
  });
});
