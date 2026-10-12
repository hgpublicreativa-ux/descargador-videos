const express = require('express');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const tempDir = os.tmpdir();
const ytdlp = fs.existsSync('/app/yt-dlp') ? '/app/yt-dlp' : 'yt-dlp';

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
  if (is('facebook.com') || is('fb.watch')) return 'Facebook';
  return null;
}

// Traduce los errores de yt-dlp a mensajes entendibles para el usuario.
function friendlyError(stderr, platform) {
  const text = stderr || '';
  if (/confirm you.re not a bot|Sign in to confirm/i.test(text)) {
    return `${platform} bloqueó la descarga desde el servidor (pide verificación anti-bot). Configura cookies en YTDLP_COOKIES o intenta más tarde.`;
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return `${platform} está limitando las descargas (demasiadas solicitudes). Intenta en unos minutos.`;
  }
  if (/login required|log in|private|empty media response|use --cookies|rate-limit reached|requested content is not available/i.test(text)) {
    return `Este video de ${platform} requiere iniciar sesión o es privado. Configura cookies en YTDLP_COOKIES.`;
  }
  if (/Unsupported URL|is not a valid URL/i.test(text)) {
    return 'El link no es válido o no corresponde a un video.';
  }
  if (/Video unavailable|has been removed|not available/i.test(text)) {
    return 'El video no está disponible (fue eliminado o tiene restricciones).';
  }
  const lastError = text.split('\n').reverse().find((l) => l.startsWith('ERROR:'));
  return lastError ? lastError.replace(/^ERROR:\s*/, '') : 'Error al descargar el video';
}

function probeCodecs(filePath, cb) {
  const args = ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', filePath];
  execFile('ffprobe', args, (err, out) => {
    const result = { video: '', audio: '' };
    (out || '').trim().split('\n').forEach((line) => {
      const [codec, type] = line.split(',');
      if (type === 'video' && !result.video) result.video = codec;
      if (type === 'audio' && !result.audio) result.audio = codec;
    });
    cb(result);
  });
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

  // Se pasan los argumentos como lista (sin shell) para que el link no
  // pueda inyectar comandos en el servidor.
  const args = [
    '--no-playlist',
    '--no-progress',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    // Preferir h264 + audio m4a (aac) para que se reproduzca en Mac/iPhone.
    '-f', 'bestvideo[vcodec^=avc]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/hd/sd/bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '-o', outputPath,
  ];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  args.push('--', url);

  const proc = spawn(ytdlp, args);
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  proc.stdout.resume();

  const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5 * 60 * 1000);

  // Si el usuario cierra la página, detener la descarga.
  res.on('close', () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  });

  proc.on('error', (err) => {
    clearTimeout(killTimer);
    console.error('No se pudo ejecutar yt-dlp:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'yt-dlp no está instalado en el servidor' });
    }
  });

  proc.on('close', (code) => {
    clearTimeout(killTimer);
    if (res.writableEnded || res.destroyed) return cleanup();

    if (code !== 0) {
      console.error(`yt-dlp terminó con código ${code}:\n${stderr.slice(-2000)}`);
      cleanup();
      return res.status(500).json({ error: friendlyError(stderr, platform) });
    }

    if (!fs.existsSync(outputPath)) {
      cleanup();
      return res.status(500).json({ error: 'No se encontró el archivo descargado' });
    }

    // QuickTime/iPhone solo reproducen video h264/hevc y audio aac/mp3.
    // Si viene en otro formato (VP9, AV1, opus...), reconvertimos lo necesario.
    probeCodecs(outputPath, ({ video, audio }) => {
      const videoOk = ['h264', 'hevc'].includes(video);
      const audioOk = !audio || ['aac', 'mp3'].includes(audio);

      if (videoOk && audioOk) return sendFile(outputPath);

      console.log(`Recodificando video=${video} audio=${audio}`);
      const fixedPath = path.join(tempDir, `video_${id}_fixed.mp4`);
      const recodeArgs = ['-y', '-i', outputPath];
      recodeArgs.push(...(videoOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']));
      recodeArgs.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', fixedPath);

      execFile('ffmpeg', recodeArgs, { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (recErr) => {
        fs.unlink(outputPath, () => {});
        if (recErr || !fs.existsSync(fixedPath)) {
          console.error('Recode error:', recErr && recErr.message);
          fs.unlink(fixedPath, () => {});
          return res.status(500).json({ error: 'Error al convertir el video a formato compatible' });
        }
        sendFile(fixedPath);
      });
    });
  });

  // Borra archivos temporales (incluye restos .part de descargas fallidas).
  function cleanup() {
    fs.readdir(tempDir, (err, files) => {
      if (err) return;
      files
        .filter((f) => f.startsWith(`video_${id}`))
        .forEach((f) => fs.unlink(path.join(tempDir, f), () => {}));
    });
  }

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

app.listen(PORT, () => {
  console.log(`\n🎬 Descargador de videos corriendo en http://localhost:${PORT}\n`);
});
