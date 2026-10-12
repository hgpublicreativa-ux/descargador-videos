const express = require('express');
const { execFile } = require('child_process');
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
const jsRuntimeArgs = ['--js-runtimes', jsRuntimePath ? `node:${jsRuntimePath}` : 'node'];
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
  return Array.from({ length: count }, () => ['--add-header', `${randomLetters(8, 24)}:${randomLetters(16, 32)}`]).flat();
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
function runYtdlp(buildArgs, options, outputPath, done) {
  const authArgs = [[], ...(cookiesFile ? [] : cookieBrowsers.map((b) => ['--cookies-from-browser', b]))];

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
    // execFile (sin shell): el link va como argumento literal y no puede ejecutar comandos.
    execFile(ytdlp, buildArgs(authArgs[i]), options, (error, stdout, stderr) => {
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

// Se mira el dominio real del link (no un "includes" sobre todo el texto), así un link como
// https://otro-sitio.com/?youtube.com no cuela como YouTube.
function detectPlatform(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    host = parsed.hostname.toLowerCase();
  } catch (e) {
    return null;
  }
  const is = (domain) => host === domain || host.endsWith('.' + domain);
  if (is('youtube.com') || is('youtu.be')) return 'YouTube';
  if (is('tiktok.com')) return 'TikTok';
  if (is('instagram.com')) return 'Instagram';
  if (is('facebook.com') || is('fb.watch') || is('fb.com')) return 'Facebook';
  return null;
}

// Traduce los errores de yt-dlp a mensajes que el usuario entienda.
function friendlyError(stderr, platform) {
  const text = stderr || '';
  if (/confirm you.re not a bot|Sign in to confirm/i.test(text)) {
    return `${platform} pidió verificación anti-bot. Configura cookies (YTDLP_COOKIES) o intenta más tarde.`;
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return `${platform} está limitando las descargas (demasiadas solicitudes). Intenta en unos minutos.`;
  }
  if (/login required|log ?in|private|empty media response|use --cookies|requested content is not available/i.test(text)) {
    return `Este video de ${platform} requiere iniciar sesión o es privado.`;
  }
  if (/Unsupported URL|is not a valid URL/i.test(text)) {
    return 'El link no es válido o no corresponde a un video.';
  }
  if (/Video unavailable|has been removed|not available/i.test(text)) {
    return 'El video no está disponible (fue eliminado o tiene restricciones).';
  }
  const lastError = text.split('\n').reverse().find((l) => l.startsWith('ERROR:'));
  return lastError ? lastError.replace(/^ERROR:\s*/, '').slice(0, 300) : 'Error al descargar el video';
}

app.post('/api/download', (req, res) => {
  const url = (req.body && typeof req.body.url === 'string') ? req.body.url.trim() : '';

  if (!url) {
    return res.status(400).json({ error: 'URL es requerida' });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: 'Plataforma no soportada' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(tempDir, `video_${id}.mp4`);

  const cookiesArgs = cookiesFile ? ['--cookies', cookiesFile] : [];
  // Solo TikTok: es el unico sitio donde upstream aplica este truco, y no queremos alterar
  // sin motivo las peticiones al resto de plataformas.
  const headersArgs = platform === 'TikTok' ? blockbusterHeaders() : [];

  // Selección de formato para máxima calidad final (no solo máxima calidad de descarga).
  // - bv*+ba: mejor vídeo + mejor audio por separado; b: formato único (TikTok/Instagram
  //   sirven todo muxeado, así que ahí siempre cae en "b").
  // - bytevc2 es el códec propio de ByteDance (h266/VVC): ni QuickTime ni ffmpeg lo
  //   decodifican, así que se excluye o la descarga acaba en un archivo inservible.
  const formatArgs = ['-f', 'bv*[vcodec!=bytevc2]+ba/b[vcodec!=bytevc2]/bv*+ba/b'];

  // Orden de preferencia: resolución y fps mandan, pero con tope en 1080p. Por encima de
  // 1080p YouTube solo ofrece VP9/AV1, que QuickTime no reproduce, y recodificar un 4K a
  // h264 va más lento que tiempo real: un video de 3 min tardaba >4 min y moría por
  // timeout. Hasta 1080p sí hay h264, así que a igualdad de resolución se elige h264 y no
  // hace falta recode. Audio m4a (aac) primero para que suene en QuickTime/iPhone.
  const sortArgs = ['-S', 'res:1080,fps,vcodec:h264,acodec:aac,br,size'];

  // La app de escritorio abierta desde Finder no tiene ffmpeg en el PATH: sin indicarle a
  // yt-dlp dónde está el empaquetado, baja vídeo y audio por separado (YouTube) y no puede
  // unirlos, así que termina "bien" pero sin archivo final.
  const ffmpegArgs = path.isAbsolute(ffmpegBin) ? ['--ffmpeg-location', path.dirname(ffmpegBin)] : [];

  const buildArgs = (authArgs) => [
    ...cookiesArgs, ...authArgs, ...headersArgs, ...jsRuntimeArgs, ...ffmpegArgs, ...formatArgs, ...sortArgs,
    '--no-playlist', '--no-progress', '--merge-output-format', 'mp4', '-o', outputPath,
    '--', url,
  ];

  // maxBuffer: yt-dlp escupe bastante texto en descargas largas y el default de 1 MB mata el
  // proceso a media descarga con ENOBUFS.
  const execOptions = { timeout: 300000, maxBuffer: 10 * 1024 * 1024, env: ytdlpEnv };

  runYtdlp(buildArgs, execOptions, outputPath, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      cleanup();
      const message = error.killed
        ? 'La descarga tardó demasiado y se canceló. Prueba con un video más corto.'
        : friendlyError(`${stderr || ''}\n${error.message}`, platform);
      return res.status(500).json({
        error: message,
        // Anti-bot, sesión o video borrado no se arreglan reintentando al instante.
        retryable: message === 'Error al descargar el video' || /timed out|network|connection reset/i.test(message),
        details: error.message
      });
    }

    if (!fs.existsSync(outputPath)) {
      cleanup();
      return res.status(500).json({ error: 'No se encontró el archivo descargado' });
    }

    // Verificar los códecs. QuickTime/Quick Look de Mac e iPhone solo reproducen vídeo
    // h264/hevc y audio aac/mp3. Si el vídeo viene en VP9, AV1, etc. se pasa a h264; si solo
    // falla el audio (p. ej. opus) se copia el vídeo tal cual y se convierte solo el audio.
    const probeArgs = ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', outputPath];
    execFile(ffprobeBin, probeArgs, (probeErr, probeOut) => {
      // ffprobe puede repetir el mismo stream (MP4 generados desde HLS/MPEG-TS), así que nos
      // quedamos con el primero de cada tipo.
      let videoCodec = '';
      let audioCodec = '';
      (probeOut || '').trim().split('\n').forEach((line) => {
        const [codec, type] = line.trim().split(',');
        if (type === 'video' && !videoCodec) videoCodec = codec;
        if (type === 'audio' && !audioCodec) audioCodec = codec;
      });
      const videoOk = ['h264', 'hevc'].includes(videoCodec);
      const audioOk = !audioCodec || ['aac', 'mp3'].includes(audioCodec);

      if (videoOk && audioOk) {
        return sendFile(outputPath);
      }

      console.log(`Recodificando video=${videoCodec} audio=${audioCodec}`);
      const fixedPath = path.join(tempDir, `video_${id}_fixed.mp4`);
      const recodeArgs = [
        '-y', '-nostats', '-loglevel', 'error', '-i', outputPath,
        ...(videoOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', fixedPath,
      ];
      execFile(ffmpegBin, recodeArgs, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (recErr) => {
        fs.unlink(outputPath, () => {});
        if (recErr || !fs.existsSync(fixedPath)) {
          console.error('Recode error:', recErr && recErr.message);
          cleanup();
          return res.status(500).json({ error: 'Error al convertir el video a formato compatible' });
        }
        sendFile(fixedPath);
      });
    });

    function sendFile(filePath) {
      if (res.destroyed) return fs.unlink(filePath, () => {});
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="video_${platform.toLowerCase()}_${id}.mp4"`);
      res.setHeader('Content-Length', fs.statSync(filePath).size);

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      stream.on('close', () => fs.unlink(filePath, () => {}));
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        res.destroy();
      });
    }
  });

  // Borra los temporales de esta descarga (incluye restos .part de descargas fallidas).
  function cleanup() {
    fs.readdir(tempDir, (err, files) => {
      if (err) return;
      files
        .filter((f) => f.startsWith(`video_${id}`))
        .forEach((f) => fs.unlink(path.join(tempDir, f), () => {}));
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`\n🎬 Descargador de videos corriendo en http://localhost:${PORT}\n`);
});
