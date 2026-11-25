import Anthropic from "@anthropic-ai/sdk";

const str = { type: ["string", "null"] };
const num = { type: ["number", "null"] };
const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tipoComprobante", "codigoArca", "puntoVenta", "numero", "fecha", "emisorNombre", "emisorCuit", "receptorNombre", "receptorDocTipo", "receptorDoc", "items", "neto", "iva", "total", "cae", "caeVto", "categoriaSugerida", "legible"],
  properties: {
    tipoComprobante: { type: "string", enum: ["Factura A", "Factura B", "Factura C", "Nota de crédito A", "Nota de crédito B", "Nota de crédito C", "Nota de débito A", "Nota de débito B", "Nota de débito C", "Ticket", "Recibo", "Otro"] },
    codigoArca: num, puntoVenta: num, numero: num,
    fecha: { ...str, description: "AAAA-MM-DD" },
    emisorNombre: str, emisorCuit: { ...str, description: "solo dígitos" },
    receptorNombre: str, receptorDocTipo: { type: ["string", "null"], enum: ["CUIT", "DNI", "CF", null] }, receptorDoc: str,
    items: { type: "array", items: { type: "object", additionalProperties: false, required: ["desc", "cant", "precio"], properties: { desc: { type: "string" }, cant: { type: "number" }, precio: { type: "number", description: "precio unitario" } } } },
    neto: num, iva: num, total: num,
    cae: { ...str, description: "14 dígitos" }, caeVto: { ...str, description: "AAAA-MM-DD" },
    categoriaSugerida: { type: "string", enum: ["Mercadería", "Alquiler", "Servicios", "Sueldos", "Impuestos", "Otros"] },
    legible: { type: "boolean" },
  },
};

export type Archivo = { mime: string; datos: Buffer };
export class OcrError extends Error {}

const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/** Lee un comprobante (foto o PDF) y devuelve sus datos. Nada se guarda: el usuario los revisa antes. */
export async function leerComprobante(client: Anthropic, archivo: Archivo, negocio: { nombre: string; cuit: string }) {
  const b64 = archivo.datos.toString("base64");
  let bloque: Anthropic.Beta.BetaContentBlockParam;
  if (archivo.mime === "application/pdf") bloque = { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
  else if ((TIPOS_IMAGEN as readonly string[]).includes(archivo.mime)) bloque = { type: "image", source: { type: "base64", media_type: archivo.mime as (typeof TIPOS_IMAGEN)[number], data: b64 } };
  else throw new OcrError("Subí una foto (JPG, PNG o WebP) o un PDF.");

  const instruccion = `Sos un asistente contable argentino. El archivo es un comprobante (factura, ticket, nota de crédito o recibo), fotografiado o escaneado.
Extraé sus datos. Usá null para lo que no se vea con claridad: no inventes valores. Los importes van como números, sin símbolo ni separador de miles. Las fechas en formato AAAA-MM-DD. Los CUIT y documentos, solo dígitos.
"codigoArca" es el código de comprobante de ARCA si figura (por ejemplo 11 para Factura C). "legible" es false si no se llega a leer el comprobante.
El negocio que usa el sistema es "${negocio.nombre}"${negocio.cuit ? ` (CUIT ${negocio.cuit})` : ""}: si figura como emisor, el comprobante es una venta propia.`;

  let resp;
  try {
    resp = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
      messages: [{ role: "user", content: [bloque, { type: "text", text: instruccion }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new OcrError("Hay muchas lecturas en curso. Probá de nuevo en un minuto.");
    if (e instanceof Anthropic.BadRequestError) throw new OcrError("No se pudo procesar el archivo. Probá con otra foto o PDF.");
    if (e instanceof Anthropic.AuthenticationError) throw new OcrError("La lectura con IA no está configurada en el servidor.");
    if (e instanceof Anthropic.APIError) throw new OcrError("El servicio de lectura no respondió. Probá de nuevo.");
    throw e;
  }
  if (resp.stop_reason === "refusal") throw new OcrError("No se pudo procesar ese archivo.");
  if (resp.stop_reason === "max_tokens") throw new OcrError("El comprobante es demasiado largo para leerlo de una vez.");
  const texto = resp.content.map(b => (b.type === "text" ? b.text : "")).join("");
  try { return JSON.parse(texto) as Record<string, unknown>; }
  catch { throw new OcrError("No se pudo interpretar el comprobante. Probá con una foto más nítida."); }
}
