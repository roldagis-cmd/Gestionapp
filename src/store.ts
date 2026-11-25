import pg from "pg";
import { randomUUID } from "node:crypto";

export type Rol = "dueño" | "contador" | "usuario";
export interface Usuario { id: string; email: string; nombre: string; passwordHash: string }
export interface Empresa { id: string; nombre: string; cuit: string }
export interface Membresia { empresa: Empresa; rol: Rol }
export interface CredencialArca { ambiente: "homologacion" | "produccion"; certEnc: string; keyEnc: string; actualizado: string }
export interface TokenArca { token: string; sign: string; vence: string }

export const COLECCIONES = ["clientes", "proveedores", "movs", "facturas", "productos", "turnos", "config"] as const;
export type Coleccion = (typeof COLECCIONES)[number];
export type Doc = Record<string, unknown> & { id: string };

/** Almacenamiento: usuarios, empresas y los datos de cada empresa como documentos JSON por colección. */
export interface Store {
  init(): Promise<void>;
  crearUsuario(email: string, nombre: string, passwordHash: string): Promise<Usuario>;
  usuarioPorEmail(email: string): Promise<Usuario | null>;
  usuarioPorId(id: string): Promise<Usuario | null>;
  crearEmpresa(nombre: string, duenioId: string): Promise<Empresa>;
  agregarMiembro(empresaId: string, usuarioId: string, rol: Rol): Promise<void>;
  membresias(usuarioId: string): Promise<Membresia[]>;
  rolEn(usuarioId: string, empresaId: string): Promise<Rol | null>;
  listar(empresaId: string): Promise<Record<Coleccion, Doc[]>>;
  obtener(empresaId: string, col: Coleccion, id: string): Promise<Doc | null>;
  guardar(empresaId: string, col: Coleccion, doc: Doc): Promise<void>;
  borrar(empresaId: string, col: Coleccion, id: string): Promise<void>;
  guardarCredencial(empresaId: string, c: Omit<CredencialArca, "actualizado">): Promise<void>;
  credencial(empresaId: string): Promise<CredencialArca | null>;
  guardarToken(empresaId: string, clave: string, t: TokenArca): Promise<void>;
  token(empresaId: string, clave: string): Promise<TokenArca | null>;
}

const vacio = (): Record<Coleccion, Doc[]> => ({ clientes: [], proveedores: [], movs: [], facturas: [], productos: [], turnos: [], config: [] });

export class MemoryStore implements Store {
  usuarios = new Map<string, Usuario>();
  empresas = new Map<string, Empresa>();
  miembros = new Map<string, Rol>(); // `${usuario}|${empresa}`
  docs = new Map<string, Doc>(); // `${empresa}|${col}|${id}`
  creds = new Map<string, CredencialArca>();
  tokens = new Map<string, TokenArca>();
  async init() {}
  async crearUsuario(email: string, nombre: string, passwordHash: string) {
    if (await this.usuarioPorEmail(email)) throw new Error("EMAIL_EXISTE");
    const u = { id: randomUUID(), email: email.toLowerCase(), nombre, passwordHash };
    this.usuarios.set(u.id, u); return u;
  }
  async usuarioPorEmail(email: string) { return [...this.usuarios.values()].find(u => u.email === email.toLowerCase()) ?? null; }
  async usuarioPorId(id: string) { return this.usuarios.get(id) ?? null; }
  async crearEmpresa(nombre: string, duenioId: string) {
    const e = { id: randomUUID(), nombre, cuit: "" }; this.empresas.set(e.id, e);
    await this.agregarMiembro(e.id, duenioId, "dueño"); return e;
  }
  async agregarMiembro(empresaId: string, usuarioId: string, rol: Rol) { this.miembros.set(`${usuarioId}|${empresaId}`, rol); }
  async membresias(usuarioId: string) {
    const out: Membresia[] = [];
    for (const [k, rol] of this.miembros) { const [u, e] = k.split("|"); if (u === usuarioId && this.empresas.has(e)) out.push({ empresa: this.empresas.get(e)!, rol }); }
    return out;
  }
  async rolEn(usuarioId: string, empresaId: string) { return this.miembros.get(`${usuarioId}|${empresaId}`) ?? null; }
  async listar(empresaId: string) {
    const out = vacio();
    for (const [k, d] of this.docs) { const [e, c] = k.split("|"); if (e === empresaId) out[c as Coleccion].push(structuredClone(d)); }
    return out;
  }
  async obtener(empresaId: string, col: Coleccion, id: string) { const d = this.docs.get(`${empresaId}|${col}|${id}`); return d ? structuredClone(d) : null; }
  async guardar(empresaId: string, col: Coleccion, doc: Doc) { this.docs.set(`${empresaId}|${col}|${doc.id}`, structuredClone(doc)); }
  async borrar(empresaId: string, col: Coleccion, id: string) { this.docs.delete(`${empresaId}|${col}|${id}`); }
  async guardarCredencial(empresaId: string, c: Omit<CredencialArca, "actualizado">) {
    this.creds.set(empresaId, { ...c, actualizado: new Date().toISOString() });
    for (const k of [...this.tokens.keys()]) if (k.startsWith(empresaId + "|")) this.tokens.delete(k);
  }
  async credencial(empresaId: string) { return this.creds.get(empresaId) ?? null; }
  async guardarToken(empresaId: string, clave: string, t: TokenArca) { this.tokens.set(`${empresaId}|${clave}`, t); }
  async token(empresaId: string, clave: string) { return this.tokens.get(`${empresaId}|${clave}`) ?? null; }
}

const ESQUEMA = `
create table if not exists usuarios (id text primary key, email text unique not null, nombre text not null default '', password_hash text not null, creado timestamptz not null default now());
create table if not exists empresas (id text primary key, nombre text not null, cuit text not null default '', creado timestamptz not null default now());
create table if not exists membresias (usuario_id text not null references usuarios(id) on delete cascade, empresa_id text not null references empresas(id) on delete cascade, rol text not null, primary key (usuario_id, empresa_id));
create table if not exists docs (empresa_id text not null references empresas(id) on delete cascade, coleccion text not null, id text not null, data jsonb not null, actualizado timestamptz not null default now(), primary key (empresa_id, coleccion, id));
create table if not exists arca_credenciales (empresa_id text primary key references empresas(id) on delete cascade, ambiente text not null, cert_enc text not null, key_enc text not null, actualizado timestamptz not null default now());
create table if not exists arca_tokens (empresa_id text not null references empresas(id) on delete cascade, clave text not null, token text not null, sign text not null, vence timestamptz not null, primary key (empresa_id, clave));
`;

export class PgStore implements Store {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  }
  async init() { await this.pool.query(ESQUEMA); }
  private u(r: any): Usuario { return { id: r.id, email: r.email, nombre: r.nombre, passwordHash: r.password_hash }; }
  async crearUsuario(email: string, nombre: string, passwordHash: string) {
    try {
      const r = await this.pool.query("insert into usuarios (id,email,nombre,password_hash) values ($1,$2,$3,$4) returning *", [randomUUID(), email.toLowerCase(), nombre, passwordHash]);
      return this.u(r.rows[0]);
    } catch (e: any) { if (e.code === "23505") throw new Error("EMAIL_EXISTE"); throw e; }
  }
  async usuarioPorEmail(email: string) { const r = await this.pool.query("select * from usuarios where email=$1", [email.toLowerCase()]); return r.rows[0] ? this.u(r.rows[0]) : null; }
  async usuarioPorId(id: string) { const r = await this.pool.query("select * from usuarios where id=$1", [id]); return r.rows[0] ? this.u(r.rows[0]) : null; }
  async crearEmpresa(nombre: string, duenioId: string) {
    const id = randomUUID();
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("insert into empresas (id,nombre) values ($1,$2)", [id, nombre]);
      await c.query("insert into membresias (usuario_id,empresa_id,rol) values ($1,$2,'dueño')", [duenioId, id]);
      await c.query("commit");
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
    return { id, nombre, cuit: "" };
  }
  async agregarMiembro(empresaId: string, usuarioId: string, rol: Rol) {
    await this.pool.query("insert into membresias (usuario_id,empresa_id,rol) values ($1,$2,$3) on conflict (usuario_id,empresa_id) do update set rol=excluded.rol", [usuarioId, empresaId, rol]);
  }
  async membresias(usuarioId: string) {
    const r = await this.pool.query("select e.id,e.nombre,e.cuit,m.rol from membresias m join empresas e on e.id=m.empresa_id where m.usuario_id=$1 order by e.nombre", [usuarioId]);
    return r.rows.map((x: any) => ({ empresa: { id: x.id, nombre: x.nombre, cuit: x.cuit }, rol: x.rol as Rol }));
  }
  async rolEn(usuarioId: string, empresaId: string) {
    const r = await this.pool.query("select rol from membresias where usuario_id=$1 and empresa_id=$2", [usuarioId, empresaId]);
    return (r.rows[0]?.rol as Rol) ?? null;
  }
  async listar(empresaId: string) {
    const r = await this.pool.query("select coleccion, data from docs where empresa_id=$1", [empresaId]);
    const out = vacio();
    for (const x of r.rows) if ((COLECCIONES as readonly string[]).includes(x.coleccion)) out[x.coleccion as Coleccion].push(x.data);
    return out;
  }
  async obtener(empresaId: string, col: Coleccion, id: string) {
    const r = await this.pool.query("select data from docs where empresa_id=$1 and coleccion=$2 and id=$3", [empresaId, col, id]);
    return r.rows[0]?.data ?? null;
  }
  async guardar(empresaId: string, col: Coleccion, doc: Doc) {
    await this.pool.query("insert into docs (empresa_id,coleccion,id,data) values ($1,$2,$3,$4) on conflict (empresa_id,coleccion,id) do update set data=excluded.data, actualizado=now()", [empresaId, col, doc.id, doc]);
  }
  async borrar(empresaId: string, col: Coleccion, id: string) { await this.pool.query("delete from docs where empresa_id=$1 and coleccion=$2 and id=$3", [empresaId, col, id]); }
  async guardarCredencial(empresaId: string, c: Omit<CredencialArca, "actualizado">) {
    await this.pool.query("insert into arca_credenciales (empresa_id,ambiente,cert_enc,key_enc) values ($1,$2,$3,$4) on conflict (empresa_id) do update set ambiente=excluded.ambiente, cert_enc=excluded.cert_enc, key_enc=excluded.key_enc, actualizado=now()", [empresaId, c.ambiente, c.certEnc, c.keyEnc]);
    await this.pool.query("delete from arca_tokens where empresa_id=$1", [empresaId]);
  }
  async credencial(empresaId: string) {
    const r = await this.pool.query("select * from arca_credenciales where empresa_id=$1", [empresaId]);
    const x = r.rows[0]; return x ? { ambiente: x.ambiente, certEnc: x.cert_enc, keyEnc: x.key_enc, actualizado: new Date(x.actualizado).toISOString() } : null;
  }
  async guardarToken(empresaId: string, clave: string, t: TokenArca) {
    await this.pool.query("insert into arca_tokens (empresa_id,clave,token,sign,vence) values ($1,$2,$3,$4,$5) on conflict (empresa_id,clave) do update set token=excluded.token, sign=excluded.sign, vence=excluded.vence", [empresaId, clave, t.token, t.sign, t.vence]);
  }
  async token(empresaId: string, clave: string) {
    const r = await this.pool.query("select token,sign,vence from arca_tokens where empresa_id=$1 and clave=$2", [empresaId, clave]);
    const x = r.rows[0]; return x ? { token: x.token, sign: x.sign, vence: new Date(x.vence).toISOString() } : null;
  }
}
