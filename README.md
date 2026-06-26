# 🎬 Descargador de Videos

Una aplicación web simple para descargar videos de YouTube, TikTok, Instagram y Facebook.

## 📋 Requisitos

- **Node.js** (v14 o superior) - [Descargar](https://nodejs.org/)
- **yt-dlp** - [Descargar](https://github.com/yt-dlp/yt-dlp)

### Instalación de yt-dlp

**En macOS (usando Homebrew):**
```bash
brew install yt-dlp
```

**En Windows (usando Chocolatey):**
```bash
choco install yt-dlp
```

**En Linux:**
```bash
sudo apt install yt-dlp
```

**O cualquier SO:**
Descarga el ejecutable desde [GitHub](https://github.com/yt-dlp/yt-dlp/releases) y agrégalo al PATH.

## 🚀 Instalación y uso

1. **Clona o descarga este proyecto**

2. **Instala las dependencias de Node.js:**
```bash
npm install
```

3. **Inicia el servidor:**
```bash
npm start
```

4. **Abre en tu navegador:**
```
http://localhost:3000
```

5. **Pega un link** de YouTube, TikTok, Instagram o Facebook y presiona descargar

Los videos se guardarán en tu carpeta de `Descargas`

## 🎯 Plataformas soportadas

- **YouTube** - youtube.com, youtu.be
- **TikTok** - tiktok.com
- **Instagram** - instagram.com
- **Facebook** - facebook.com, fb.watch

## 📁 Estructura del proyecto

```
.
├── server.js          # Backend (Express)
├── package.json       # Dependencias
├── public/
│   ├── index.html     # Interfaz
│   ├── styles.css     # Estilos
│   └── script.js      # Lógica del cliente
└── README.md
```

## ⚙️ Notas técnicas

- Usa **yt-dlp** para las descargas (la versión mejorada y mantenida de youtube-dl)
- Todo es **open source** y **gratuito**
- Los videos se descargan en la mejor calidad disponible
- La app detecta automáticamente la plataforma de la URL

## 📝 Licencia

MIT
