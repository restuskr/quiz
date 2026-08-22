# Perubahan: comeback bonus 2x + floor skor -1000 (mode taruhan)

File yang diubah: `lib/game.js`

## Apa yang berubah

1. **Floor skor (`SCORE_FLOOR = -1000`)**
   - Skor peserta tidak akan pernah turun di bawah -1000.
   - Diterapkan lewat helper baru `applyScoreDelta(player, delta)`, dipakai di semua tempat yang mengubah `player.score`:
     - saat membatalkan poin jawaban lama (submitAnswer)
     - saat menambah/mengurangi poin dari jawaban baru (submitAnswer)
     - saat penalti flat karena tidak menjawab di mode taruhan (reveal)

2. **Bonus comeback 2x (`COMEBACK_MULTIPLIER = 2`)**
   - Kalau skor peserta masih MINUS (di bawah 0) saat dia menjawab BENAR di mode taruhan, poin dari stake yang menang dikali 2 (bonus beruntun tetap ditambahkan seperti biasa, tidak dikali).
   - Kalau jawabannya salah, potongan stake tetap normal (tidak digandakan), supaya penalti tidak makin berat saat sedang di posisi minus.
   - Field `breakdown.comeback: true` ditambahkan pada rincian poin saat bonus ini aktif, supaya nanti bisa ditampilkan ke klien kalau perlu.

## Yang TIDAK diubah

- Opsi taruhan dinamis 'Setengah' dan 'All In' di `wagerChoicesFor()` masih disembunyikan saat skor peserta <= 0, seperti semula. Peserta yang minus tetap memilih dari stake tetap 25/50/100, sekarang dengan floor + bonus comeback di atas.
- Mode klasik (non-wager) dan semua alur lain tidak tersentuh.

## Cara pakai patch ini

Timpa `lib/game.js` di repo `restuskr/quiz` (branch `v2`) dengan file `lib/game.js` pada zip ini, lalu commit.
