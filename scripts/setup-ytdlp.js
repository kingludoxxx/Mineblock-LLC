#!/usr/bin/env node
/**
 * Downloads yt-dlp binary during build for video URL extraction from Facebook, TikTok, etc.
 * yt-dlp is a single standalone binary — no Python or pip required at runtime.
 */
import { execSync } from 'child_process';
import { existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'bin', 'yt-dlp');

if (existsSync(binPath)) {
  console.log('[setup-ytdlp] yt-dlp already exists, skipping download');
  process.exit(0);
}

console.log('[setup-ytdlp] Downloading yt-dlp binary...');

try {
  // Create bin directory
  execSync(`mkdir -p ${join(__dirname, '..', 'bin')}`);

  // Detect platform — Render uses Linux x64
  const platform = process.platform;
  const arch = process.arch;

  let url;
  if (platform === 'linux' && arch === 'x64') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
  } else if (platform === 'darwin') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  } else {
    // Universal Python version as fallback
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  }

  execSync(`curl -sL "${url}" -o "${binPath}"`, { stdio: 'inherit' });
  chmodSync(binPath, 0o755);

  console.log(`[setup-ytdlp] yt-dlp downloaded successfully to ${binPath}`);
} catch (err) {
  console.warn(`[setup-ytdlp] WARNING: Could not download yt-dlp: ${err.message}`);
  console.warn('[setup-ytdlp] Video URL extraction from Facebook/TikTok will not be available.');
  // Don't fail the build — this is optional
  process.exit(0);
}
