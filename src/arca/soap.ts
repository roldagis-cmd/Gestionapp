import { XMLParser } from "fast-xml-parser";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, trimValues: true });

export function parseXml(xml: string): any { return parser.parse(xml); }

export const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export class ArcaError extends Error {
  constructor(message: string, public detalle?: unknown) { super(message); }
}

/** Envía un sobre SOAP 1.1 y devuelve el contenido de <Body> ya parseado. */
export async function soap(fetchFn: FetchLike, url: string, action: string, envelope: string): Promise<any> {
  let res;
  try {
    res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"` }, body: envelope, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new ArcaError("No se pudo conectar con ARCA. Probá de nuevo en unos minutos.", String(e));
  }
  const text = await res.text();
  let doc: any;
  try { doc = parseXml(text); } catch { throw new ArcaError(`ARCA respondió algo inesperado (HTTP ${res.status}).`, text.slice(0, 500)); }
  const body = doc?.Envelope?.Body;
  if (!body) throw new ArcaError(`ARCA respondió algo inesperado (HTTP ${res.status}).`, text.slice(0, 500));
  if (body.Fault) throw new ArcaError(String(body.Fault.faultstring || "Error de ARCA"), body.Fault);
  return body;
}
