import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { COLECCIONES, type Coleccion, type Rol, type Store } from "./store.js";
import { cifrar } from "./cifrado.js";
import { ServicioArca } from "./arca/servicio.js";
import { ArcaError, type FetchLike } from "./arca/soap.js";
import { leerComprobante, OcrError } from "./ocr.js";
import type { Config } from "./config.js";
import { correoBrevo, correoConsola, mensajeCodigo, mensajeInvitacion, type Correo } from "./correo.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = "gapp_sesion";

interface ReqAuth extends Request { usuarioId?: string; empresaId?: string; rol?: Rol }

export interface Deps { store: Store; config: Config; fetchFn?: FetchLike; anthropic?: Anthropic | null; correo?: Correo }

export function crearApp({ store, config, fetchFn, anthropic, correo }: Deps) {
  const app = express();
  const arca = new ServicioArca(store, config.masterKey, fetchFn);
  const claude = anthropic !== undefined ? anthropic : config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
  const mail: Correo = correo ?? (config.brevoApiKey && config.mailFrom ? correoBrevo(config.brevoApiKey, config.mailFrom, fetchFn) : correoConsola);
  const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 2 } });

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Las llamadas que modifican datos exigen este encabezado: un formulario de otro sitio no puede enviarlo (protección CSRF).
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.get("x-gestionapp") !== "1") return res.status(403).json({ error: "Solicitud no permitida." });
    next();
  });

  const firmar = (res: Response, usuarioId: string) => {
    const t = jwt.sign({ sub: usuarioId }, config.sessionSecret, { expiresIn: "30d" });
    res.cookie(COOKIE, t, { httpOnly: true, sameSite: "lax", secure: config.produccion, maxAge: 30 * 86400 * 1000, path: "/" });
  };
  const autenticado = (req: ReqAuth, res: Response, next: NextFunction) => {
    try {
      const p = jwt.verify(req.cookies?.[COOKIE] ?? "", config.sessionSecret) as { sub: string };
      req.usuarioId = p.sub; next();
    } catch { res.status(401).json({ error: "Tenés que iniciar sesión." }); }
  };
  const enEmpresa = (roles?: Rol[]) => async (req: ReqAuth, res: Response, next: NextFunction) => {
    const rol = await store.rolEn(req.usuarioId!, String(req.params.eid));
    if (!rol) return res.status(404).json({ error: "No existe esa empresa o no tenés acceso." });
    if (roles && !roles.includes(rol)) return res.status(403).json({ error: "Tu rol no permite esta acción." });
    req.empresaId = String(req.params.eid); req.rol = rol; next();
  };
  const h = (fn: (req: ReqAuth, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req as ReqAuth, res).catch(next);

  // ---------- sesión ----------
  // Ingreso sin contraseña: la persona escribe su email y recibe un código de 6 dígitos.
  const VIGENCIA_MS = 10 * 60 * 1000, ESPERA_MS = 60 * 1000, MAX_INTENTOS = 5;
  const Email = z.string().trim().toLowerCase().email().max(200);
  const hashCodigo = (email: string, codigo: string) => createHmac("sha256", config.sessionSecret).update(`${email}:${codigo}`).digest("hex");
  // Límite por dirección IP, en memoria (alcanza para una sola instancia).
  const pedidos = new Map<string, number[]>();
  const limite = (clave: string, max: number, ventanaMs: number) => {
    const ahora = Date.now(), lista = (pedidos.get(clave) ?? []).filter(t => ahora - t < ventanaMs);
    if (lista.length >= max) { pedidos.set(clave, lista); return false; }
    lista.push(ahora); pedidos.set(clave, lista);
    if (pedidos.size > 10000) for (const [k, v] of pedidos) if (!v.some(t => ahora - t < ventanaMs)) pedidos.delete(k);
    return true;
  };
  const urlDe = (req: Request) => `${req.protocol}://${req.get("host")}/`;

  app.post("/api/auth/codigo", h(async (req, res) => {
    const p = Email.safeParse(req.body?.email);
    if (!p.success) return res.status(400).json({ error: "Escribí un email válido." });
    const email = p.data;
    if (!limite(`codigo|${req.ip}`, 10, 15 * 60 * 1000)) return res.status(429).json({ error: "Pediste demasiados códigos. Esperá unos minutos y probá de nuevo." });
    const previo = await store.codigo(email);
    if (previo && Date.now() - Date.parse(previo.enviado) < ESPERA_MS) return res.status(429).json({ error: "Ya te mandamos un código. Esperá un minuto para pedir otro." });
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const ahora = Date.now();
    await store.guardarCodigo(email, { hash: hashCodigo(email, codigo), vence: new Date(ahora + VIGENCIA_MS).toISOString(), intentos: 0, enviado: new Date(ahora).toISOString() });
    const m = mensajeCodigo(codigo);
    try { await mail.enviar(email, m.asunto, m.texto, m.html); }
    catch (e) {
      await store.borrarCodigo(email);
      console.error("No se pudo enviar el código:", e);
      return res.status(502).json({ error: "No pudimos enviar el email. Revisá la dirección o probá en unos minutos." });
    }
    res.json({ ok: true });
  }));
  app.post("/api/auth/verificar", h(async (req, res) => {
    const p = Email.safeParse(req.body?.email);
    const codigo = String(req.body?.codigo ?? "").replace(/\D/g, "");
    if (!p.success || codigo.length !== 6) return res.status(400).json({ error: "Escribí los 6 números del código." });
    if (!limite(`verificar|${req.ip}`, 30, 15 * 60 * 1000)) return res.status(429).json({ error: "Demasiados intentos. Esperá unos minutos." });
    const email = p.data, c = await store.codigo(email);
    if (!c || Date.parse(c.vence) < Date.now()) return res.status(400).json({ error: "El código venció. Pedí uno nuevo." });
    if (c.intentos >= MAX_INTENTOS) { await store.borrarCodigo(email); return res.status(400).json({ error: "Demasiados intentos con ese código. Pedí uno nuevo." }); }
    const ok = timingSafeEqual(Buffer.from(hashCodigo(email, codigo)), Buffer.from(c.hash));
    if (!ok) {
      await store.sumarIntento(email);
      const quedan = MAX_INTENTOS - c.intentos - 1;
      return res.status(400).json({ error: quedan > 0 ? `El código no es correcto. Te ${quedan === 1 ? "queda 1 intento" : `quedan ${quedan} intentos`}.` : "El código no es correcto. Pedí uno nuevo." });
    }
    await store.borrarCodigo(email);
    let u = await store.usuarioPorEmail(email);
    if (!u) {
      try { u = await store.crearUsuario(email, ""); }
      catch (e) { if (e instanceof Error && e.message === "EMAIL_EXISTE") u = await store.usuarioPorEmail(email); else throw e; }
    }
    firmar(res, u!.id); res.json({ ok: true, nuevo: !u!.nombre });
  }));
  app.post("/api/auth/logout", (_req, res) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); });
  app.get("/api/me", autenticado, h(async (req, res) => {
    const u = await store.usuarioPorId(req.usuarioId!);
    if (!u) return res.status(401).json({ error: "Tenés que iniciar sesión." });
    const ms = await store.membresias(u.id);
    res.json({ usuario: { id: u.id, email: u.email, nombre: u.nombre }, empresas: ms.map(m => ({ ...m.empresa, rol: m.rol })), ocr: !!claude });
  }));
  app.put("/api/me", autenticado, h(async (req, res) => {
    const nombre = String(req.body?.nombre ?? "").trim();
    if (!nombre) return res.status(400).json({ error: "Escribí tu nombre." });
    await store.cambiarNombre(req.usuarioId!, nombre.slice(0, 120)); res.json({ ok: true });
  }));

  // ---------- empresas ----------
  app.post("/api/empresas", autenticado, h(async (req, res) => {
    const nombre = String(req.body?.nombre ?? "").trim();
    if (!nombre) return res.status(400).json({ error: "Escribí el nombre de la empresa." });
    res.status(201).json(await store.crearEmpresa(nombre.slice(0, 160), req.usuarioId!));
  }));
  app.post("/api/empresas/:eid/miembros", autenticado, enEmpresa(["dueño", "contador"]), h(async (req, res) => {
    const rol = String(req.body?.rol) as Rol;
    if (!["contador", "usuario"].includes(rol)) return res.status(400).json({ error: "El rol tiene que ser contador o usuario." });
    const p = Email.safeParse(req.body?.email);
    if (!p.success) return res.status(400).json({ error: "Escribí un email válido." });
    let u = await store.usuarioPorEmail(p.data);
    if (!u) {
      try { u = await store.crearUsuario(p.data, ""); }
      catch (e) { if (e instanceof Error && e.message === "EMAIL_EXISTE") u = await store.usuarioPorEmail(p.data); else throw e; }
    }
    await store.agregarMiembro(req.empresaId!, u!.id, rol);
    // Aviso por email: si falla, el acceso igual queda dado.
    const empresa = (await store.membresias(req.usuarioId!)).find(m => m.empresa.id === req.empresaId)?.empresa.nombre ?? "una empresa";
    const m = mensajeInvitacion(empresa, urlDe(req));
    let avisado = true;
    try { await mail.enviar(p.data, m.asunto, m.texto, m.html); } catch (e) { avisado = false; console.error("No se pudo enviar la invitación:", e); }
    res.json({ ok: true, avisado });
  }));

  // ---------- datos ----------
  const esCol = (c: string): c is Coleccion => (COLECCIONES as readonly string[]).includes(c);
  const ID = /^[A-Za-z0-9_.:@+-]{1,120}$/;
  app.get("/api/empresas/:eid/datos", autenticado, enEmpresa(), h(async (req, res) => {
    const d = await store.listar(req.empresaId!);
    res.json({ ...d, config: d.config.find(x => x.id === "negocio") ?? null, rol: req.rol });
  }));
  app.put("/api/empresas/:eid/:col/:id", autenticado, enEmpresa(), h(async (req, res) => {
    const { col, id } = req.params as { col: string; id: string };
    if (!esCol(col) || !ID.test(id)) return res.status(404).json({ error: "Ruta inválida." });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Datos inválidos." });
    if (col === "facturas") {
      const prev = await store.obtener(req.empresaId!, "facturas", id);
      // Una factura con CAE de ARCA no se puede reescribir desde la app.
      if (prev && prev.estado === "autorizada" && prev.ambiente === "produccion") return res.status(409).json({ error: "Esta factura ya fue autorizada por ARCA y no se puede modificar. Emití una nota de crédito." });
    }
    if (col === "config" && req.rol === "usuario") return res.status(403).json({ error: "Tu rol no permite cambiar los ajustes." });
    await store.guardar(req.empresaId!, col, { ...body, id });
    res.json({ ok: true });
  }));
  app.delete("/api/empresas/:eid/:col/:id", autenticado, enEmpresa(), h(async (req, res) => {
    const { col, id } = req.params as { col: string; id: string };
    if (!esCol(col) || col === "config") return res.status(404).json({ error: "Ruta inválida." });
    if (col === "facturas") {
      const prev = await store.obtener(req.empresaId!, "facturas", id);
      if (prev && prev.estado === "autorizada" && prev.ambiente === "produccion") return res.status(409).json({ error: "Una factura autorizada por ARCA no se puede borrar. Emití una nota de crédito." });
    }
    await store.borrar(req.empresaId!, col, id); res.json({ ok: true });
  }));

  // ---------- ARCA ----------
  app.get("/api/empresas/:eid/arca", autenticado, enEmpresa(), h(async (req, res) => {
    const c = await store.credencial(req.empresaId!);
    res.json(c ? { configurado: true, ambiente: c.ambiente, actualizado: c.actualizado } : { configurado: false });
  }));
  app.post("/api/empresas/:eid/arca/credenciales", autenticado, enEmpresa(["dueño", "contador"]), subida.fields([{ name: "cert", maxCount: 1 }, { name: "key", maxCount: 1 }]), h(async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const cert = files?.cert?.[0]?.buffer.toString("utf8") ?? "", key = files?.key?.[0]?.buffer.toString("utf8") ?? "";
    const ambiente = req.body?.ambiente === "produccion" ? "produccion" : "homologacion";
    if (!/BEGIN CERTIFICATE/.test(cert)) return res.status(400).json({ error: "El certificado tiene que ser el archivo .crt (PEM) que descargaste de ARCA." });
    if (!/BEGIN (RSA )?PRIVATE KEY/.test(key)) return res.status(400).json({ error: "La clave tiene que ser el archivo .key (PEM) con el que generaste el pedido." });
    await store.guardarCredencial(req.empresaId!, { ambiente, certEnc: cifrar(cert, config.masterKey), keyEnc: cifrar(key, config.masterKey) });
    res.json({ ok: true, ambiente });
  }));
  app.post("/api/empresas/:eid/arca/probar", autenticado, enEmpresa(), h(async (req, res) => {
    res.json(await arca.probar(req.empresaId!, Number(req.body?.puntoVenta) || 1));
  }));
  app.post("/api/empresas/:eid/facturas/:fid/autorizar", autenticado, enEmpresa(), h(async (req, res) => {
    res.json(await arca.autorizar(req.empresaId!, String(req.params.fid)));
  }));

  // ---------- lectura de comprobantes ----------
  app.post("/api/empresas/:eid/ocr", autenticado, enEmpresa(), subida.single("archivo"), h(async (req, res) => {
    if (!claude) return res.status(503).json({ error: "La lectura con IA no está configurada en el servidor." });
    const f = req.file;
    if (!f) return res.status(400).json({ error: "Subí una foto o un PDF del comprobante." });
    const cfg = await store.obtener(req.empresaId!, "config", "negocio");
    res.json(await leerComprobante(claude, { mime: f.mimetype, datos: f.buffer }, { nombre: String(cfg?.razonSocial || cfg?.nombre || ""), cuit: String(cfg?.cuit ?? "").replace(/\D/g, "") }));
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "No existe esa ruta." }));
  app.use(express.static(path.join(aqui, "..", "public"), { index: "index.html", maxAge: "1h" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ArcaError) return res.status(422).json({ error: err.message });
    if (err instanceof OcrError) return res.status(422).json({ error: err.message });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "El archivo supera los 20 MB." : "No se pudo recibir el archivo." });
    console.error(err);
    res.status(500).json({ error: "Ocurrió un error en el servidor." });
  });
  return app;
}
