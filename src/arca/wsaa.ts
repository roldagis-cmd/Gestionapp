import forge from "node-forge";
import { soap, parseXml, ArcaError, type FetchLike } from "./soap.js";

export type Ambiente = "homologacion" | "produccion";
export const WSAA_URL: Record<Ambiente, string> = {
  homologacion: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  produccion: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
};

/** Ticket de requerimiento de acceso (TRA) para un servicio de ARCA. */
export function armarTRA(servicio: string, ahora = new Date()): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const desde = new Date(ahora.getTime() - 10 * 60 * 1000);
  const hasta = new Date(ahora.getTime() + 10 * 60 * 1000);
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId><generationTime>${iso(desde)}</generationTime><expirationTime>${iso(hasta)}</expirationTime></header><service>${servicio}</service></loginTicketRequest>`;
}

/** Firma el TRA como CMS (PKCS#7 SignedData con el contenido incluido), en base64. */
export function firmarTRA(tra: string, certPem: string, keyPem: string): string {
  let cert: forge.pki.Certificate, key: forge.pki.PrivateKey;
  try { cert = forge.pki.certificateFromPem(certPem); } catch { throw new ArcaError("El certificado no es válido: tiene que ser el .crt en formato PEM que descargaste de ARCA."); }
  try { key = forge.pki.privateKeyFromPem(keyPem); } catch { throw new ArcaError("La clave privada no es válida: tiene que ser el .key en formato PEM con el que generaste el pedido de certificado."); }
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key: key as forge.pki.rsa.PrivateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

export interface Credenciales { token: string; sign: string; vence: string }

export async function loginCms(fetchFn: FetchLike, ambiente: Ambiente, cms: string): Promise<Credenciales> {
  const env = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  let body;
  try { body = await soap(fetchFn, WSAA_URL[ambiente], "", env); }
  catch (e) {
    if (e instanceof ArcaError && /alreadyAuthenticated|ya posee un TA valido/i.test(e.message)) throw new ArcaError("ARCA ya emitió un acceso hace pocos minutos y todavía no venció. Esperá unos minutos y probá de nuevo.", e.detalle);
    if (e instanceof ArcaError && /cms\.cert\.untrusted|notAuthorized|no autorizado/i.test(e.message)) throw new ArcaError("ARCA no reconoce el certificado o no tiene autorizado el servicio de facturación electrónica (wsfe). Revisá la relación del certificado en Administración de Certificados Digitales.", e.detalle);
    throw e;
  }
  const ret = body?.loginCmsResponse?.loginCmsReturn;
  if (!ret) throw new ArcaError("ARCA no devolvió el acceso.");
  const t = parseXml(String(ret))?.loginTicketResponse;
  const token = t?.credentials?.token, sign = t?.credentials?.sign, vence = t?.header?.expirationTime;
  if (!token || !sign) throw new ArcaError("ARCA no devolvió el acceso.");
  return { token: String(token), sign: String(sign), vence: new Date(String(vence)).toISOString() };
}
