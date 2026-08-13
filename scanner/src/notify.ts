import { spawn } from 'node:child_process';

/**
 * Notifikasi desktop lewat `notify-send`.
 *
 * Ini satu-satunya jalur yang sampai ke pemakai saat ia tidak sedang melihat halaman
 * maupun terminal — persis situasi yang membuat 1,5 jam data sesi 1 hilang pada
 * 13 Agu 2026 tanpa ada yang sadar.
 *
 * Sengaja fire-and-forget: kalau `notify-send` tidak terpasang, atau service systemd
 * `--user` tidak punya akses ke D-Bus session, kegagalannya diabaikan. Scanner tidak
 * boleh berhenti hanya karena notifikasi tidak bisa tampil.
 */
export function desktopNotify(title: string, body: string, critical = false) {
  try {
    const p = spawn('notify-send', [
      '--app-name=Whale Scanner',
      `--urgency=${critical ? 'critical' : 'normal'}`,
      title,
      body,
    ], { stdio: 'ignore', detached: true });
    // Tanpa handler ini, ENOENT (notify-send tidak ada) menjadi uncaught exception.
    p.on('error', () => {});
    p.unref();
  } catch { /* notifikasi bukan alasan menjatuhkan scanner */ }
}
