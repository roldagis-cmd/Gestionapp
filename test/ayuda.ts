import forge from "node-forge";

export function certificadoDePrueba() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: "gestionapp-test" }, { shortName: "C", value: "AR" }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

const sobre = (cuerpo: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const respuestas = {
  login: (vence = new Date(Date.now() + 12 * 3600e3).toISOString()) => sobre(`<ns1:loginCmsResponse xmlns:ns1="http://wsaa.view.sua.dvadac.desein.afip.gov"><ns1:loginCmsReturn>${esc(`<?xml version="1.0" encoding="UTF-8"?><loginTicketResponse version="1.0"><header><source>CN=wsaahomo</source><destination>SERIALNUMBER=CUIT 20123456786</destination><uniqueId>1</uniqueId><generationTime>2026-11-25T00:00:00-03:00</generationTime><expirationTime>${vence}</expirationTime></header><credentials><token>TOKEN123</token><sign>SIGN456</sign></credentials></loginTicketResponse>`)}</ns1:loginCmsReturn></ns1:loginCmsResponse>`),
  ultimo: (n: number) => sobre(`<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult><PtoVta>2</PtoVta><CbteTipo>11</CbteTipo><CbteNro>${n}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`),
  cae: (n: number) => sobre(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>2</PtoVta><CbteTipo>11</CbteTipo><FchProceso>20261125</FchProceso><CantReg>1</CantReg><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${n}</CbteDesde><CbteHasta>${n}</CbteHasta><CbteFch>20261125</CbteFch><Resultado>A</Resultado><CAE>76123456789012</CAE><CAEFchVto>20261205</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`),
  rechazo: () => sobre(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>DocNro invalido</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp><Errors><Err><Code>10016</Code><Msg>Numero incorrecto</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse>`),
};

/** fetch falso que responde según el SOAPAction y registra los pedidos. */
export function arcaFalsa(opciones: { ultimo?: number; rechazar?: boolean } = {}) {
  const pedidos: { url: string; action: string; body: string }[] = [];
  const fn = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const action = init.headers.SOAPAction.replace(/"/g, "");
    pedidos.push({ url, action, body: init.body });
    let xml = "";
    if (url.includes("LoginCms")) xml = respuestas.login();
    else if (action.endsWith("FECompUltimoAutorizado")) xml = respuestas.ultimo(opciones.ultimo ?? 41);
    else if (action.endsWith("FECAESolicitar")) xml = opciones.rechazar ? respuestas.rechazo() : respuestas.cae(Number(/<ar:CbteDesde>(\d+)</.exec(init.body)?.[1]));
    return { ok: true, status: 200, text: async () => xml };
  };
  return { fn, pedidos };
}
