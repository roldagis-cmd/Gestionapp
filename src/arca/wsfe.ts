import { soap, escapeXml, ArcaError, type FetchLike } from "./soap.js";
import type { Ambiente, Credenciales } from "./wsaa.js";

export const WSFE_URL: Record<Ambiente, string> = {
  homologacion: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  produccion: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
};
const NS = "http://ar.gov.afip.dif.FEV1/";

export interface Auth extends Pick<Credenciales, "token" | "sign"> { cuit: string }

/** Tipos de documento del receptor (tabla de ARCA). */
export const DOC_TIPO: Record<string, number> = { CUIT: 80, CUIL: 86, DNI: 96, CF: 99 };
/** Condición frente al IVA del receptor (RG 5616). */
export const CONDICION_IVA: Record<string, number> = { "responsable-inscripto": 1, exento: 4, "consumidor-final": 5, monotributo: 6, "no-categorizado": 7, "monotributo-social": 13 };
/** Concepto: 1 productos, 2 servicios, 3 productos y servicios. */
export const CONCEPTO: Record<string, number> = { Productos: 1, Servicios: 2, "Productos y servicios": 3 };

export interface SolicitudCAE {
  cbteTipo: number; puntoVenta: number; numero: number; fecha: string; // AAAA-MM-DD
  concepto: number; docTipo: number; docNro: string; condicionIva: number; total: number;
  servDesde?: string; servHasta?: string; vtoPago?: string;
  asociado?: { tipo: number; puntoVenta: number; numero: number; fecha: string; cuit?: string };
}
export interface RespuestaCAE { resultado: "A" | "R"; cae: string; caeVto: string; numero: number; observaciones: string[] }

const f8 = (iso: string) => iso.replace(/-/g, "");
const iso = (f: string) => (/^\d{8}$/.test(f) ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : f);
const imp = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const arr = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

function sobre(metodo: string, auth: Auth, cuerpo = "") {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}"><soap:Body><ar:${metodo}><ar:Auth><ar:Token>${escapeXml(auth.token)}</ar:Token><ar:Sign>${escapeXml(auth.sign)}</ar:Sign><ar:Cuit>${auth.cuit.replace(/\D/g, "")}</ar:Cuit></ar:Auth>${cuerpo}</ar:${metodo}></soap:Body></soap:Envelope>`;
}

function errores(r: any): string[] {
  return arr(r?.Errors?.Err).map((e: any) => `${e.Code}: ${e.Msg}`);
}

export async function ultimoAutorizado(fetchFn: FetchLike, amb: Ambiente, auth: Auth, puntoVenta: number, cbteTipo: number): Promise<number> {
  const body = await soap(fetchFn, WSFE_URL[amb], NS + "FECompUltimoAutorizado", sobre("FECompUltimoAutorizado", auth, `<ar:PtoVta>${puntoVenta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`));
  const r = body?.FECompUltimoAutorizadoResponse?.FECompUltimoAutorizadoResult;
  const errs = errores(r);
  if (errs.length) throw new ArcaError("ARCA rechazó la consulta: " + errs.join(" | "), r);
  return Number(r?.CbteNro ?? 0);
}

export function armarFECAESolicitar(auth: Auth, s: SolicitudCAE): string {
  const servicios = s.concepto === 2 || s.concepto === 3;
  const docNro = s.docTipo === 99 ? "0" : s.docNro.replace(/\D/g, "");
  const det = [
    `<ar:Concepto>${s.concepto}</ar:Concepto>`,
    `<ar:DocTipo>${s.docTipo}</ar:DocTipo>`,
    `<ar:DocNro>${docNro || "0"}</ar:DocNro>`,
    `<ar:CbteDesde>${s.numero}</ar:CbteDesde>`,
    `<ar:CbteHasta>${s.numero}</ar:CbteHasta>`,
    `<ar:CbteFch>${f8(s.fecha)}</ar:CbteFch>`,
    `<ar:ImpTotal>${imp(s.total)}</ar:ImpTotal>`,
    `<ar:ImpTotConc>0.00</ar:ImpTotConc>`,
    // Comprobantes C: el neto es el total y no se discrimina IVA
    `<ar:ImpNeto>${imp(s.total)}</ar:ImpNeto>`,
    `<ar:ImpOpEx>0.00</ar:ImpOpEx>`,
    `<ar:ImpTrib>0.00</ar:ImpTrib>`,
    `<ar:ImpIVA>0.00</ar:ImpIVA>`,
    servicios ? `<ar:FchServDesde>${f8(s.servDesde || s.fecha)}</ar:FchServDesde><ar:FchServHasta>${f8(s.servHasta || s.fecha)}</ar:FchServHasta><ar:FchVtoPago>${f8(s.vtoPago || s.fecha)}</ar:FchVtoPago>` : "",
    `<ar:MonId>PES</ar:MonId>`,
    `<ar:MonCotiz>1</ar:MonCotiz>`,
    `<ar:CondicionIVAReceptorId>${s.condicionIva}</ar:CondicionIVAReceptorId>`,
    s.asociado ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${s.asociado.tipo}</ar:Tipo><ar:PtoVta>${s.asociado.puntoVenta}</ar:PtoVta><ar:Nro>${s.asociado.numero}</ar:Nro>${s.asociado.cuit ? `<ar:Cuit>${s.asociado.cuit.replace(/\D/g, "")}</ar:Cuit>` : ""}<ar:CbteFch>${f8(s.asociado.fecha)}</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>` : "",
  ].join("");
  return sobre("FECAESolicitar", auth, `<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${s.puntoVenta}</ar:PtoVta><ar:CbteTipo>${s.cbteTipo}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq><ar:FECAEDetRequest>${det}</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`);
}

export async function solicitarCAE(fetchFn: FetchLike, amb: Ambiente, auth: Auth, s: SolicitudCAE): Promise<RespuestaCAE> {
  const body = await soap(fetchFn, WSFE_URL[amb], NS + "FECAESolicitar", armarFECAESolicitar(auth, s));
  const r = body?.FECAESolicitarResponse?.FECAESolicitarResult;
  const det = arr(r?.FeDetResp?.FECAEDetResponse)[0] as any;
  const obs = arr(det?.Observaciones?.Obs).map((o: any) => `${o.Code}: ${o.Msg}`);
  const errs = errores(r);
  if (!det) throw new ArcaError("ARCA rechazó el comprobante: " + (errs.join(" | ") || "sin detalle"), r);
  const resultado = det.Resultado === "A" ? "A" : "R";
  if (resultado === "R") throw new ArcaError("ARCA rechazó el comprobante: " + [...errs, ...obs].join(" | "), r);
  return { resultado, cae: String(det.CAE), caeVto: iso(String(det.CAEFchVto)), numero: Number(det.CbteDesde), observaciones: obs };
}

export async function dummy(fetchFn: FetchLike, amb: Ambiente): Promise<{ app: string; db: string; auth: string }> {
  const body = await soap(fetchFn, WSFE_URL[amb], NS + "FEDummy", `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}"><soap:Body><ar:FEDummy/></soap:Body></soap:Envelope>`);
  const r = body?.FEDummyResponse?.FEDummyResult ?? {};
  return { app: String(r.AppServer), db: String(r.DbServer), auth: String(r.AuthServer) };
}
