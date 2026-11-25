# GESTIONAPP (Gapp)

Sistema de gestión para pymes y monotributistas: ventas, gastos, caja, cuentas corrientes de clientes y proveedores, **facturación electrónica con ARCA**, control de la **categoría de monotributo**, **stock**, **turnero** para servicios y **lectura de comprobantes con IA**.

Una misma cuenta puede manejar varias empresas (pensado para el estudio contable que lleva a varias pymes) y darles acceso a otras personas con rol de contador o usuario.

## Cómo está hecho

- **Servidor:** Node.js 22 + Express + TypeScript (`src/`).
- **Base de datos:** PostgreSQL. Las tablas se crean solas al arrancar. Sin `DATABASE_URL`, en desarrollo los datos quedan en memoria.
- **Interfaz:** una sola página sin compilación (`public/index.html`).
- **ARCA:** autenticación WSAA (firma CMS del ticket de acceso con el certificado de la empresa) y factura electrónica WSFEv1 (`FECompUltimoAutorizado` + `FECAESolicitar`). Comprobantes C (Factura, Nota de crédito y Nota de débito) para monotributistas, con la condición frente al IVA del receptor que exige la RG 5616.
- **Ingreso sin contraseña:** la persona escribe su email y recibe un código de 6 dígitos (vence en 10 minutos, 5 intentos, se guarda solo su hash). La primera vez la cuenta se crea sola. Los emails salen por la API de [Brevo](https://www.brevo.com) (plan gratis: 300 por día). En desarrollo, sin Brevo, el código aparece en la consola del servidor.
- **Certificados:** se guardan cifrados con AES-256-GCM usando `MASTER_KEY`. Nunca se suben al repositorio.
- **Lectura de comprobantes:** API de Claude (modelo `claude-opus-5-5`, con fallback del servidor si el modelo declina). Lee fotos y PDF; el usuario revisa los datos antes de guardar.

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar lo que haga falta
npm run dev            # http://localhost:3000 (el código de ingreso se ve en la consola)
npm test               # pruebas (incluye firma CMS verificada con OpenSSL)
```

## Publicarla gratis (Render + Neon)

1. **Base de datos:** creá un proyecto gratuito en [Neon](https://neon.tech) y copiá la cadena de conexión (`postgres://…?sslmode=require`).
2. **Servidor:** en [Render](https://render.com), *New → Blueprint*, elegí este repositorio. Toma `render.yaml` y crea el servicio web gratuito.
3. Completá las variables de entorno en Render:
   - `DATABASE_URL`: la cadena de Neon.
   - `MASTER_KEY`: 32 bytes en base64, generados con `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Guardala en un lugar seguro**: si se pierde, hay que volver a cargar los certificados de ARCA.
   - `BREVO_API_KEY` y `MAIL_FROM`: para enviar los códigos de ingreso. Creá una cuenta gratis en Brevo, verificá el email remitente (Senders) y generá una clave API (SMTP & API → API Keys). `MAIL_FROM` es ese email verificado. Para que no caigan en spam conviene, más adelante, autenticar un dominio propio en Brevo.
   - `ANTHROPIC_API_KEY`: opcional, activa la lectura de comprobantes con IA.
   - `SESSION_SECRET` lo genera Render solo.
4. Cada cambio que se aprueba en `main` se publica automáticamente.

El plan gratuito de Render se "duerme" tras unos 15 minutos sin uso; la primera visita después tarda alrededor de un minuto. El plan pago más chico lo evita.

## Certificado de ARCA (por empresa)

1. Generar clave y pedido:
   ```bash
   openssl genrsa -out empresa.key 2048
   openssl req -new -key empresa.key -subj "/C=AR/O=Empresa/CN=gestionapp/serialNumber=CUIT 20123456789" -out empresa.csr
   ```
2. Con clave fiscal: **WSASS** (homologación) o **Administración de Certificados Digitales** (producción) → crear alias, subir el `.csr`, descargar el `.crt`.
3. **Administrador de Relaciones de Clave Fiscal** → asociar el certificado al servicio *Facturación Electrónica* (`wsfe`).
4. Crear un punto de venta *Factura electrónica – Web Services* y cargarlo en **Ajustes → Datos para las facturas**.
5. En **Ajustes → Facturación electrónica**, subir `.crt` y `.key`, elegir ambiente y tocar **Probar conexión**. Conviene probar primero en homologación: esos CAE no tienen validez fiscal y la app los marca como "prueba".

## Escala de monotributo

Los topes están en `public/index.html` (constante `CATEGORIAS`), con la escala vigente de agosto 2026 a enero 2027. ARCA la actualiza en febrero y agosto: hay que cambiar esa tabla.

## Seguridad

- Sesión en cookie `httpOnly` + `SameSite=Lax`; las llamadas que modifican datos exigen el encabezado `x-gestionapp` (protección CSRF).
- Cada pedido verifica que la persona pertenezca a la empresa. El dueño y el contador pueden cargar certificados y cambiar ajustes; el rol usuario no.
- Una factura autorizada en producción no se puede modificar ni borrar desde la app: se corrige con nota de crédito.
