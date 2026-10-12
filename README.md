# 🎬 Descargador de Videos

Descarga videos de **YouTube, TikTok, Instagram y Facebook** en MP4 listo para reproducir en Mac, iPhone y Android.

Hay dos formas de usarlo, con el mismo código:

| | Versión web (Railway) | App de escritorio (Mac) |
|---|---|---|
| Dónde funciona | Cualquier navegador, incluido el móvil | Solo Mac (Intel y Apple Silicon) |
| Dónde se descarga el video | En el servidor de Railway, que luego lo envía | En tu propio Mac |
| Costo | Consume uso de Railway | Gratis, no usa Railway |
| Cookies / sesión | Variable `YTDLP_COOKIES` | Usa la sesión de tu navegador (Chrome, Brave, Edge, Firefox…) |

## ✨ Funciones

- **Cola de descargas**: pega varios links (uno por línea) y se bajan uno por uno.
- **Calidad hasta 1080p** en h264 + audio AAC, compatible con QuickTime y la galería del iPhone. Si el video viene en VP9/AV1 u opus, se convierte automáticamente.
- **Móvil**: al terminar aparece el menú de compartir (o un botón **Guardar**) para guardar el video directo en la galería.
- **Errores claros**: avisa si el video es privado, pide iniciar sesión o la plataforma bloqueó la descarga, y no reintenta cuando no sirve de nada.
- **Reintentos con sesión** (escritorio): si una descarga falla por falta de sesión, reintenta con las cookies del navegador instalado.
- **yt-dlp siempre al día**: Railway baja la última versión en cada deploy; la app de escritorio la actualiza sola una vez al día desde GitHub (con verificación sha256).

## 🌐 Versión web

### Ejecutar en local

Requisitos: **Node.js 20+**, **yt-dlp** y **ffmpeg**.

```bash
brew install yt-dlp ffmpeg
```

```bash
npm install
```

```bash
npm start
```

Abre http://localhost:3000, pega un link y pulsa **Agregar a la cola**.

### Deploy en Railway

Railway construye la imagen con el [Dockerfile](Dockerfile) (Node 22 + ffmpeg + la última versión de yt-dlp) en cada push a `main`.

Variables de entorno opcionales:

| Variable | Para qué sirve |
|---|---|
| `YTDLP_COOKIES` | Contenido de un `cookies.txt` (formato Netscape, texto o base64). Necesario para Instagram y cuando YouTube pide verificación anti-bot. Nunca se guarda en el repositorio. |
| `PORT` | Puerto (Railway lo define solo). |

## 🖥️ App de escritorio (Mac)

La app (Electron) arranca el mismo `server.js` en `127.0.0.1:51739`, solo accesible desde tu Mac, y guarda los videos directo en **Descargas** sin preguntar. Lleva dentro yt-dlp, ffmpeg y ffprobe, así que no necesita nada instalado.

### Compilar el instalador (.dmg)

1. Prepara los binarios en `resources/bin/` (esta carpeta no se sube a GitHub):

   ```
   resources/bin/
   ├── yt-dlp_macos/        # yt-dlp_macos.zip de las releases de yt-dlp, descomprimido
   │   ├── yt-dlp_macos
   │   └── _internal/
   ├── arm64/
   │   ├── ffmpeg           # binarios de ffmpeg/ffprobe para Apple Silicon
   │   └── ffprobe
   └── x64/
       ├── ffmpeg           # binarios de ffmpeg/ffprobe para Intel
       └── ffprobe
   ```

   - **yt-dlp**: usa `yt-dlp_macos.zip` (versión "carpeta"), no el `yt-dlp_macos` de un solo archivo. El de un solo archivo tarda ~30 s en arrancar en cada descarga porque macOS lo revisa cada vez.
   - **ffmpeg/ffprobe**: si ya tienes la app instalada, puedes sacar cada arquitectura de sus binarios universales:

     ```bash
     lipo "/Applications/Descargador de Videos.app/Contents/Resources/bin/ffmpeg" -thin arm64 -output resources/bin/arm64/ffmpeg
     ```

     (repite con `-thin x86_64` → `x64/`, y lo mismo para `ffprobe`).

2. Compila:

   ```bash
   npm install
   ```

   ```bash
   npm run dist
   ```

El instalador queda en `dist/Descargador de Videos-1.0.0-universal.dmg` (universal: Intel + Apple Silicon).

Para probar sin compilar: `npm run electron`.

### Instalar

Abre el `.dmg` y arrastra la app a **Aplicaciones**. La app no está firmada: la primera vez, clic derecho → **Abrir**.

## 🎯 Plataformas soportadas

- **YouTube** — youtube.com, youtu.be (incluye Shorts)
- **TikTok** — tiktok.com
- **Instagram** — instagram.com (normalmente requiere sesión/cookies)
- **Facebook** — facebook.com, fb.watch

## 📁 Estructura del proyecto

```
.
├── server.js          # Backend (Express + yt-dlp + ffmpeg), usado por la web y la app
├── main.js            # App de escritorio (Electron): ventana, binarios, Descargas
├── updater.js         # Actualización diaria de yt-dlp en la app de escritorio
├── Dockerfile         # Imagen para Railway
├── package.json       # Dependencias y configuración de electron-builder
├── public/
│   ├── index.html     # Interfaz
│   ├── styles.css     # Estilos
│   └── script.js      # Cola de descargas y guardado en móvil
├── assets/, build/    # Iconos de la app
└── resources/bin/     # Binarios para compilar la app (no se sube a GitHub)
```

## ⚙️ Notas técnicas

- yt-dlp necesita un runtime de JavaScript para YouTube (`--js-runtimes node`). En Railway es el Node de la imagen; en la app de escritorio es el propio binario de Electron (`ELECTRON_RUN_AS_NODE=1`).
- yt-dlp y ffmpeg se ejecutan sin shell (`execFile`), así que un link no puede inyectar comandos en el servidor.
- El tope de 1080p es intencional: por encima YouTube solo ofrece VP9/AV1, y convertir un 4K a h264 es más lento que tiempo real.

## 📝 Licencia

MIT
