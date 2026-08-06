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

  const command = `"${ytdlp}" ${cookiesArg} --js-runtime node ${formatArg} ${sortArg} --merge-output-format mp4 -o "${outputPath}" "${url}"`;

  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
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
      const codec = (codecOut || '').trim();
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
