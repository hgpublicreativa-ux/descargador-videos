const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const tempDir = os.tmpdir();
// YTDLP_PATH/FFMPEG_PATH/FFPROBE_PATH: usados por la app de escritorio (Electron) para
// apuntar a los binarios empaquetados dentro del .app. Sin definir, cae en el binario
// instalado en Railway (/app/yt-dlp) o en el PATH del sistema (Homebrew local).
const ytdlp = process.env.YTDLP_PATH || (fs.existsSync('/app/yt-dlp') ? '/app/yt-dlp' : 'yt-dlp');
const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
// HOST: la app de escritorio fuerza 127.0.0.1 para no exponer el server en la red local.
// Railway necesita todas las interfaces, que es el default.
const HOST = process.env.HOST || '0.0.0.0';
// JS_RUNTIME_PATH: la app de escritorio apunta al propio binario de Electron, que hace de
// node cuando se le pasa ELECTRON_RUN_AS_NODE=1. En Railway/Homebrew basta con 'node' porque
// ahi si esta en el PATH del proceso.
const jsRuntimePath = process.env.JS_RUNTIME_PATH;
const jsRuntimeArg = jsRuntimePath ? `--js-runtimes "node:${jsRuntimePath}"` : '--js-runtimes node';
const ytdlpEnv = jsRuntimePath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;

// Cookies opcionales (para Instagram y otras plataformas que exigen login).
// Se cargan desde la variable de entorno YTDLP_COOKIES (texto del archivo
// cookies.txt en formato Netscape, o el mismo contenido en base64).
// Nunca se guardan en el repositorio: solo viven en Railway como variable privada.
let cookiesFile = null;
const cookiesEnv = process.env.YTDLP_COOKIES;
if (cookiesEnv && cookiesEnv.trim()) {
  let content = cookiesEnv;
  if (!content.includes('\t') && !content.includes('# Netscape')) {
    try { content = Buffer.from(content, 'base64').toString('utf8'); } catch (e) { /* usar tal cual */ }
  }
  cookiesFile = path.join(tempDir, 'cookies.txt');
  fs.writeFileSync(cookiesFile, content);
  console.log('🍪 Cookies cargadas para descargas autenticadas');
}

// TikTok identifica el conjunto exacto de cabeceras que manda yt-dlp y, cuando lo reconoce,
// devuelve una pagina de bloqueo del WAF ("Site Maintenance") en lugar de la del video; el
// extractor no encuentra los datos y aborta con "Unexpected response from webpage request".
// yt-dlp lo arreglo en master el 2026-08-18 (commit b375e1d8, "[ie/tiktok] Fix extractor")
// anadiendo cabeceras de nombre y valor aleatorios para romper esa huella, pero la version
// estable que llevamos empaquetada (2026.07.04) es anterior y no lo trae. Replicamos aqui su
// misma solucion via --add-header. Las letras excluyen vocales para no generar por accidente
// un nombre de cabecera real ("authorization" y compania).
function blockbusterHeaders() {
  const letters = 'bcdfghjklmnpqrstvwxz';
  const randomLetters = (min, max) => {
    const len = min + Math.floor(Math.random() * (max - min + 1));
    return Array.from({ length: len }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  };
  const count = 2 + Math.floor(Math.random() * 7); // 2..8, como upstream
  return Array.from({ length: count }, () => `--add-header "${randomLetters(8, 24)}:${randomLetters(16, 32)}"`).join(' ');
}

// COOKIES_FROM_BROWSER: lista de navegadores instalados que pone la app de escritorio. Se usan
// solo como reintento cuando la descarga ya ha fallado por falta de sesión: leer las cookies de
// Chrome dispara una petición de permiso al Llavero, y no tiene sentido provocarla en cada
// descarga que iba a funcionar sin ella. En Railway la lista viene vacía y se usa YTDLP_COOKIES.
const cookieBrowsers = (process.env.COOKIES_FROM_BROWSER || '')
  .split(',').map((b) => b.trim()).filter(Boolean);

// Fallos que se arreglan aportando una sesión iniciada. El resto (URL mal escrita, vídeo
// borrado, sin red) no mejora por reintentar con cookies, así que no se reintenta.
const NEEDS_LOGIN = /sign in|log ?in|not a bot|cookies|private|429|too many requests/i;

// Ejecuta yt-dlp y, si falla por falta de sesión, lo reintenta con las cookies de cada
// navegador instalado hasta que uno funcione.
function runYtdlp(buildCommand, options, outputPath, done) {
  const authArgs = ['', ...(cookiesFile ? [] : cookieBrowsers.map((b) => `--cookies-from-browser ${b}`))];

  // Higiene entre intentos: si el primero murió a mitad de descarga deja el .mp4 incompleto y
  // los fragmentos .part/.fXXX, y no queremos que el reintento los dé por buenos.
  const limpiarRestos = () => {
    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath, '.mp4');
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ya no está */ }
      }
    }
  };

  const attempt = (i) => {
    exec(buildCommand(authArgs[i]), options, (error, stdout, stderr) => {
      const output = `${stderr || ''}${error ? error.message : ''}`;
      if (error && i + 1 < authArgs.length && NEEDS_LOGIN.test(output)) {
        console.log(`Requiere sesión iniciada; reintentando con las cookies de ${cookieBrowsers[i]}`);
        limpiarRestos();
        return attempt(i + 1);
      }
      if (!error && i > 0) console.log(`Descarga completada con las cookies de ${cookieBrowsers[i - 1]}`);
      done(error, stdout, stderr);
    });
  };

  attempt(0);
}

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('tiktok.com')) return 'TikTok';
  if (url.includes('instagram.com')) return 'Instagram';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'Facebook';
  return null;
}

app.post('/api/download', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL es requerida' });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: 'Plataforma no soportada' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(tempDir, `video_${id}.mp4`);

  const cookiesArg = cookiesFile ? `--cookies "${cookiesFile}"` : '';
  // Solo TikTok: es el unico sitio donde upstream aplica este truco, y no queremos alterar
  // sin motivo las peticiones al resto de plataformas.
  const headersArg = platform === 'TikTok' ? blockbusterHeaders() : '';

  // Selección de formato para máxima calidad final (no solo máxima calidad de descarga).
  // - bv*+ba: mejor vídeo + mejor audio por separado; b: formato único (TikTok/Instagram
  //   sirven todo muxeado, así que ahí siempre cae en "b").
  // - bytevc2 es el códec propio de ByteDance (h266/VVC): ni QuickTime ni ffmpeg lo
  //   decodifican, así que se excluye o la descarga acaba en un archivo inservible.
  const formatArg = '-f "bv*[vcodec!=bytevc2]+ba/b[vcodec!=bytevc2]/bv*+ba/b"';

  // Orden de preferencia: resolución y fps mandan (es lo que pide el usuario), pero a
  // igualdad de resolución preferimos h264 porque evita el recode posterior a h264, que
  // es una recompresión con pérdida. Luego bitrate y tamaño como desempate.
  const sortArg = '-S "res,fps,vcodec:h264,br,size"';

  const buildCommand = (authArg) => `"${ytdlp}" ${cookiesArg} ${authArg} ${headersArg} ${jsRuntimeArg} ${formatArg} ${sortArg} --no-progress --merge-output-format mp4 -o "${outputPath}" "${url}"`;

  // maxBuffer: yt-dlp escupe bastante texto en descargas largas y el default de 1 MB mata el
  // proceso a media descarga con ENOBUFS.
  const execOptions = { timeout: 300000, maxBuffer: 10 * 1024 * 1024, env: ytdlpEnv };

  runYtdlp(buildCommand, execOptions, outputPath, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return res.status(500).json({
        error: 'Error al descargar el video',
        details: error.message
      });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'No se encontró el archivo descargado' });
    }

    // Verificar el códec de video. QuickTime/Quick Look de Mac solo reproducen
    // h264 y hevc. Si viene en VP9, AV1, etc., reconvertimos a h264 + aac.
    const probe = `"${ffprobeBin}" -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "${outputPath}"`;
    exec(probe, (probeErr, codecOut) => {
      // ffprobe imprime una línea por cada entrada de vídeo, y en los MP4 que yt-dlp genera a
      // partir de HLS/MPEG-TS aparece repetida (una por programa del TS) aunque el archivo
      // tenga un único stream. Comparar la cadena entera ("h264\nh264") daba "incompatible"
      // para un h264 perfecto y disparaba una recompresión con pérdida, así que nos quedamos
      // con la primera línea.
      const codec = (codecOut || '').trim().split('\n')[0].trim();
      const compatible = ['h264', 'hevc'].includes(codec);

      if (compatible) {
        return sendFile(outputPath);
      }

      // Reconvertir a h264 para compatibilidad con Mac
      console.log(`Recodificando ${codec} -> h264`);
      const fixedPath = path.join(tempDir, `video_${id}_fixed.mp4`);
      const recode = `"${ffmpegBin}" -y -i "${outputPath}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart "${fixedPath}"`;
      exec(recode, { timeout: 180000 }, (recErr) => {
        fs.unlink(outputPath, () => {});
        if (recErr || !fs.existsSync(fixedPath)) {
          console.error('Recode error:', recErr && recErr.message);
          return res.status(500).json({ error: 'Error al convertir el video a formato compatible' });
        }
        sendFile(fixedPath);
      });
    });

    function sendFile(filePath) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="video_${platform.toLowerCase()}_${id}.mp4"`);
      res.setHeader('Content-Length', fs.statSync(filePath).size);

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      stream.on('end', () => fs.unlink(filePath, () => {}));
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        fs.unlink(filePath, () => {});
      });
    }
  });
});

app.listen(PORT, HOST, () => {
  console.log(`\n🎬 Descargador de videos corriendo en http://localhost:${PORT}\n`);
});
