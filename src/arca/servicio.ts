import type { Store, Doc } from "../store.js";
import { descifrar } from "../cifrado.js";
import { armarTRA, firmarTRA, loginCms, type Ambiente } from "./wsaa.js";
import { solicitarCAE, ultimoAutorizado, DOC_TIPO, CONDICION_IVA, CONCEPTO, type Auth } from "./wsfe.js";
import { ArcaError, type FetchLike } from "./soap.js";

const NC_ND = new Set([2, 3, 7, 8, 12, 13]);

export class ServicioArca {
  private colas = new Map<string, Promise<void>>();
  constructor(private store: Store, private masterKey: Buffer, private fetchFn: FetchLike = fetch as unknown as FetchLike) {}

  /** Serializa operaciones por empresa y punto de venta para no pedir dos veces el mismo número. */
  private enCola<T>(clave: string, fn: () => Promise<T>): Promise<T> {
    const prev: Promise<void> = this.colas.get(clave) ?? Promise.resolve();
    const next = prev.then(fn);
    const fin = next.then(() => {}, () => {});
    this.colas.set(clave, fin);
    void fin.then(() => { if (this.colas.get(clave) === fin) this.colas.delete(clave); });
    return next;
  }

  async acceso(empresaId: string): Promise<{ ambiente: Ambiente; auth: Auth }> {
    const cred = await this.store.credencial(empresaId);
    if (!cred) throw new ArcaError("Todavía no cargaste el certificado de ARCA de esta empresa (Ajustes → Facturación electrónica).");
    const config = await this.store.obtener(empresaId, "config", "negocio");
    const cuit = String(config?.cuit ?? "").replace(/\D/g, "");
    if (cuit.length !== 11) throw new ArcaError("Falta el CUIT de la empresa en Ajustes.");
    const clave = `wsfe:${cred.ambiente}`;
    let t = await this.store.token(empresaId, clave);
    if (!t || new Date(t.vence).getTime() - Date.now() < 5 * 60 * 1000) {
      const cms = firmarTRA(armarTRA("wsfe"), descifrar(cred.certEnc, this.masterKey), descifrar(cred.keyEnc, this.masterKey));
      t = await loginCms(this.fetchFn, cred.ambiente, cms);
      await this.store.guardarToken(empresaId, clave, t);
    }
    return { ambiente: cred.ambiente, auth: { token: t.token, sign: t.sign, cuit } };
  }

  async probar(empresaId: string, puntoVenta: number) {
    const { ambiente, auth } = await this.acceso(empresaId);
    const ultimo = await ultimoAutorizado(this.fetchFn, ambiente, auth, puntoVenta, 11);
    return { ambiente, puntoVenta, ultimaFacturaC: ultimo };
  }

  async autorizar(empresaId: string, facturaId: string): Promise<Doc> {
    const f0 = await this.store.obtener(empresaId, "facturas", facturaId);
    if (!f0) throw new ArcaError("No existe esa factura.");
    const pv = Number(f0.puntoVenta) || 1, tipo = Number(f0.cbte) || 11;
    return this.enCola(`${empresaId}:${pv}:${tipo}`, async () => {
      const f = (await this.store.obtener(empresaId, "facturas", facturaId))!;
      if (f.estado === "autorizada" || f.estado === "importada") throw new ArcaError("Esta factura ya tiene CAE.");
      const total = Number(f.total);
      if (!(total > 0)) throw new ArcaError("El total tiene que ser mayor a cero.");
      const docTipo = DOC_TIPO[String(f.docTipo || "CF")] ?? 99;
      const condicionIva = CONDICION_IVA[String(f.condicionIva || (docTipo === 80 ? "responsable-inscripto" : "consumidor-final"))] ?? 5;
      let asociado;
      if (NC_ND.has(tipo)) {
        const a = f.asociadaId ? await this.store.obtener(empresaId, "facturas", String(f.asociadaId)) : null;
        if (!a || !a.numero) throw new ArcaError("Las notas de crédito y débito tienen que indicar la factura que corrigen.");
        asociado = { tipo: Number(a.cbte), puntoVenta: Number(a.puntoVenta), numero: Number(a.numero), fecha: String(a.fecha) };
      }
      const { ambiente, auth } = await this.acceso(empresaId);
      const numero = (await ultimoAutorizado(this.fetchFn, ambiente, auth, pv, tipo)) + 1;
      const r = await solicitarCAE(this.fetchFn, ambiente, auth, {
        cbteTipo: tipo, puntoVenta: pv, numero, fecha: String(f.fecha), concepto: CONCEPTO[String(f.concepto)] ?? 1,
        docTipo, docNro: String(f.docNro || ""), condicionIva, total, asociado,
      });
      const actualizada: Doc = { ...f, numero: r.numero, cae: r.cae, caeVto: r.caeVto, estado: "autorizada", ambiente, observacionesArca: r.observaciones };
      await this.store.guardar(empresaId, "facturas", actualizada);
      return actualizada;
    });
  }
}
