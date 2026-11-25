import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { crearApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { leerConfig } from "../src/config.js";
import { certificadoDePrueba, arcaFalsa } from "./ayuda.js";

const config = leerConfig({ NODE_ENV: "test" });
const H = { "x-gestionapp": "1" };

// Correo de prueba: guarda los emails en vez de enviarlos.
let enviados: { para: string; asunto: string; texto: string }[] = [];
const correo = { async enviar(para: string, asunto: string, texto: string) { enviados.push({ para, asunto, texto }); } };
const ultimoCodigo = (email: string) => [...enviados].reverse().find(m => m.para === email && /código/.test(m.asunto))!.texto.match(/\b(\d{6})\b/)![1];

async function ingresar(agent: any, email: string) {
  await agent.post("/api/auth/codigo").set(H).send({ email }).expect(200);
  return agent.post("/api/auth/verificar").set(H).send({ email, codigo: ultimoCodigo(email.toLowerCase()) }).expect(200);
}
async function cuenta(app: any, email: string) {
  const agent = request.agent(app);
  const r = await ingresar(agent, email);
  expect(r.body.nuevo).toBe(true);
  await agent.put("/api/me").set(H).send({ nombre: "Gisela" }).expect(200);
  await agent.post("/api/empresas").set(H).send({ nombre: "Almacén Sol" }).expect(201);
  const me = await agent.get("/api/me").expect(200);
  return { agent, empresaId: me.body.empresas[0].id as string };
}

describe("API", () => {
  let store: MemoryStore, arca: ReturnType<typeof arcaFalsa>, app: any;
  beforeEach(() => { enviados = []; store = new MemoryStore(); arca = arcaFalsa({ ultimo: 41 }); app = crearApp({ store, config, fetchFn: arca.fn, anthropic: null, correo }); });

  it("pide sesión y rechaza pedidos sin el encabezado anti-CSRF", async () => {
    await request(app).get("/api/me").expect(401);
    await request(app).post("/api/auth/codigo").send({ email: "a@b.com" }).expect(403);
  });

  it("registra, inicia sesión y guarda y lista documentos de la empresa", async () => {
    const { agent, empresaId } = await cuenta(app, "gisela@example.com");
    await agent.put(`/api/empresas/${empresaId}/clientes/c1`).set(H).send({ nombre: "Lucía" }).expect(200);
    await agent.put(`/api/empresas/${empresaId}/config/negocio`).set(H).send({ nombre: "Almacén Sol", cuit: "20-12345678-6" }).expect(200);
    const d = await agent.get(`/api/empresas/${empresaId}/datos`).expect(200);
    expect(d.body.clientes).toEqual([{ id: "c1", nombre: "Lucía" }]);
    expect(d.body.config.cuit).toBe("20-12345678-6");
    await agent.delete(`/api/empresas/${empresaId}/clientes/c1`).set(H).expect(200);
    await agent.put(`/api/empresas/${empresaId}/secretos/x`).set(H).send({}).expect(404);
  });

  it("entra con un código de 6 dígitos enviado por email", async () => {
    const a = request.agent(app);
    await a.post("/api/auth/codigo").set(H).send({ email: "no-es-mail" }).expect(400);
    await a.post("/api/auth/codigo").set(H).send({ email: " Gisela@Example.com " }).expect(200);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].para).toBe("gisela@example.com");
    const codigo = ultimoCodigo("gisela@example.com");
    expect(codigo).toMatch(/^\d{6}$/);
    // El código no queda guardado en claro
    expect(JSON.stringify([...store.codigos.values()])).not.toContain(codigo);
    // No se puede pedir otro enseguida
    await a.post("/api/auth/codigo").set(H).send({ email: "gisela@example.com" }).expect(429);
    const malo = codigo === "000000" ? "111111" : "000000";
    const r1 = await a.post("/api/auth/verificar").set(H).send({ email: "gisela@example.com", codigo: malo }).expect(400);
    expect(r1.body.error).toMatch(/quedan 4 intentos/);
    await a.get("/api/me").expect(401);
    const ok = await a.post("/api/auth/verificar").set(H).send({ email: "GISELA@example.com", codigo }).expect(200);
    expect(ok.body.nuevo).toBe(true);
    const me = await a.get("/api/me").expect(200);
    expect(me.body.usuario.email).toBe("gisela@example.com");
    // El código se usa una sola vez
    await request(app).post("/api/auth/verificar").set(H).send({ email: "gisela@example.com", codigo }).expect(400);
    // La segunda vez ya no es cuenta nueva
    await a.put("/api/me").set(H).send({ nombre: "Gisela" }).expect(200);
    store.codigos.clear();
    const otra = await ingresar(request.agent(app), "gisela@example.com");
    expect(otra.body.nuevo).toBe(false);
  });

  it("anula el código después de 5 intentos fallidos y cuando vence", async () => {
    const a = request.agent(app);
    await a.post("/api/auth/codigo").set(H).send({ email: "x@example.com" }).expect(200);
    const codigo = ultimoCodigo("x@example.com");
    const malo = codigo === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await a.post("/api/auth/verificar").set(H).send({ email: "x@example.com", codigo: malo }).expect(400);
    const r = await a.post("/api/auth/verificar").set(H).send({ email: "x@example.com", codigo }).expect(400);
    expect(r.body.error).toMatch(/Pedí uno nuevo/);
    await a.get("/api/me").expect(401);

    store.codigos.clear();
    await a.post("/api/auth/codigo").set(H).send({ email: "x@example.com" }).expect(200);
    store.codigos.get("x@example.com")!.vence = new Date(Date.now() - 1000).toISOString();
    const v = await a.post("/api/auth/verificar").set(H).send({ email: "x@example.com", codigo: ultimoCodigo("x@example.com") }).expect(400);
    expect(v.body.error).toMatch(/venció/);
  });

  it("si el email no se puede enviar, avisa y no deja un código guardado", async () => {
    const roto = { async enviar() { throw new Error("caído"); } };
    const app2 = crearApp({ store, config, fetchFn: arca.fn, anthropic: null, correo: roto });
    await request(app2).post("/api/auth/codigo").set(H).send({ email: "y@example.com" }).expect(502);
    expect(store.codigos.size).toBe(0);
  });

  it("no deja ver ni tocar empresas ajenas", async () => {
    const a = await cuenta(app, "a@example.com");
    const b = await cuenta(app, "b@example.com");
    await b.agent.get(`/api/empresas/${a.empresaId}/datos`).expect(404);
    await b.agent.put(`/api/empresas/${a.empresaId}/clientes/x`).set(H).send({ nombre: "intruso" }).expect(404);
  });

  it("la contadora invitada accede a la empresa del cliente", async () => {
    const pyme = await cuenta(app, "pyme@example.com");
    const conta = await cuenta(app, "conta@example.com");
    await pyme.agent.post(`/api/empresas/${pyme.empresaId}/miembros`).set(H).send({ email: "conta@example.com", rol: "contador" }).expect(200);
    const me = await conta.agent.get("/api/me").expect(200);
    expect(me.body.empresas.map((e: any) => e.rol).sort()).toEqual(["contador", "dueño"]);
    await conta.agent.get(`/api/empresas/${pyme.empresaId}/datos`).expect(200);
    // También se puede invitar a alguien que todavía no entró nunca: le llega un aviso y entra con su email.
    const r = await pyme.agent.post(`/api/empresas/${pyme.empresaId}/miembros`).set(H).send({ email: "Nueva@Example.com", rol: "usuario" }).expect(200);
    expect(r.body.avisado).toBe(true);
    expect(enviados.at(-1)).toMatchObject({ para: "nueva@example.com", asunto: "Te dieron acceso a Almacén Sol en GESTIONAPP" });
    const nueva = request.agent(app);
    await ingresar(nueva, "nueva@example.com");
    const me2 = await nueva.get("/api/me").expect(200);
    expect(me2.body.empresas).toMatchObject([{ id: pyme.empresaId, rol: "usuario" }]);
  });

  it("autoriza una Factura C en ARCA con el número siguiente y guarda el CAE", async () => {
    const { agent, empresaId } = await cuenta(app, "fact@example.com");
    const { certPem, keyPem } = certificadoDePrueba();
    await agent.put(`/api/empresas/${empresaId}/config/negocio`).set(H).send({ nombre: "Almacén Sol", cuit: "20-12345678-6" }).expect(200);
    await agent.post(`/api/empresas/${empresaId}/arca/credenciales`).set(H).field("ambiente", "homologacion").attach("cert", Buffer.from(certPem), "a.crt").attach("key", Buffer.from(keyPem), "a.key").expect(200);
    const estado = await agent.get(`/api/empresas/${empresaId}/arca`).expect(200);
    expect(estado.body).toMatchObject({ configurado: true, ambiente: "homologacion" });
    // El certificado queda cifrado
    expect(store.creds.get(empresaId)!.certEnc).not.toContain("BEGIN CERTIFICATE");

    await agent.put(`/api/empresas/${empresaId}/facturas/f1`).set(H).send({ cbte: 11, puntoVenta: 2, numero: 0, fecha: "2026-11-25", docTipo: "CF", docNro: "", concepto: "Productos", total: 1500, estado: "pendiente" }).expect(200);
    const r = await agent.post(`/api/empresas/${empresaId}/facturas/f1/autorizar`).set(H).expect(200);
    expect(r.body).toMatchObject({ estado: "autorizada", numero: 42, cae: "76123456789012", caeVto: "2026-12-05", ambiente: "homologacion" });
    expect(arca.pedidos.map(p => p.action.split("/").pop() || "login")).toEqual(["login", "FECompUltimoAutorizado", "FECAESolicitar"]);

    // El acceso se reutiliza mientras no venza
    await agent.put(`/api/empresas/${empresaId}/facturas/f2`).set(H).send({ cbte: 11, puntoVenta: 2, fecha: "2026-11-25", docTipo: "CF", concepto: "Productos", total: 10, estado: "pendiente" }).expect(200);
    await agent.post(`/api/empresas/${empresaId}/facturas/f2/autorizar`).set(H).expect(200);
    expect(arca.pedidos.filter(p => p.url.includes("LoginCms"))).toHaveLength(1);

    // Ya autorizada: no se vuelve a pedir CAE
    const otra = await agent.post(`/api/empresas/${empresaId}/facturas/f1/autorizar`).set(H).expect(422);
    expect(otra.body.error).toMatch(/ya tiene CAE/);
  });

  it("explica qué falta antes de facturar", async () => {
    const { agent, empresaId } = await cuenta(app, "nf@example.com");
    await agent.put(`/api/empresas/${empresaId}/facturas/f1`).set(H).send({ cbte: 11, puntoVenta: 1, fecha: "2026-11-25", total: 10, estado: "pendiente" }).expect(200);
    const r = await agent.post(`/api/empresas/${empresaId}/facturas/f1/autorizar`).set(H).expect(422);
    expect(r.body.error).toMatch(/certificado de ARCA/);
  });

  it("protege las facturas autorizadas en producción", async () => {
    const { agent, empresaId } = await cuenta(app, "prod@example.com");
    await store.guardar(empresaId, "facturas", { id: "f9", estado: "autorizada", ambiente: "produccion", total: 5 });
    await agent.delete(`/api/empresas/${empresaId}/facturas/f9`).set(H).expect(409);
    await agent.put(`/api/empresas/${empresaId}/facturas/f9`).set(H).send({ total: 1 }).expect(409);
  });

  it("lee comprobantes con IA si está configurada", async () => {
    const falso: any = { beta: { messages: { create: async (p: any) => {
      expect(p.model).toBe("claude-opus-5-5");
      expect(p.messages[0].content[0].type).toBe("document");
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ tipoComprobante: "Factura A", total: 1210, legible: true }) }] };
    } } } };
    const app2 = crearApp({ store, config, fetchFn: arca.fn, anthropic: falso, correo });
    const { agent, empresaId } = await cuenta(app2, "ocr@example.com");
    const r = await agent.post(`/api/empresas/${empresaId}/ocr`).set(H).attach("archivo", Buffer.from("%PDF-1.4"), { filename: "f.pdf", contentType: "application/pdf" }).expect(200);
    expect(r.body).toMatchObject({ tipoComprobante: "Factura A", total: 1210 });
    await agent.post(`/api/empresas/${empresaId}/ocr`).set(H).attach("archivo", Buffer.from("hola"), { filename: "a.txt", contentType: "text/plain" }).expect(422);
  });
});
