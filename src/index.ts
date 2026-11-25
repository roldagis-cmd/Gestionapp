import { leerConfig } from "./config.js";
import { MemoryStore, PgStore } from "./store.js";
import { crearApp } from "./app.js";

const config = leerConfig();
const store = config.databaseUrl ? new PgStore(config.databaseUrl) : new MemoryStore();
if (!config.databaseUrl) {
  if (config.produccion) throw new Error("Falta DATABASE_URL");
  console.warn("Sin DATABASE_URL: los datos quedan en memoria y se pierden al reiniciar.");
}
await store.init();
crearApp({ store, config }).listen(config.port, () => console.log(`GESTIONAPP escuchando en el puerto ${config.port}`));
