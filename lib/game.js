'use strict'
/**
 * Logika inti room/game Branch Battle - dipisah dari transport (HTTP/WS)
 * supaya bisa dipakai ulang dan gampang dites. Aturan skor & alur pesan sama
 * persis seperti versi awal, hanya kode room/id pemain sekarang pakai
 * `nanoid` (customAlphabet) alih-alih fungsi acak buatan sendiri.
 *
 * Mode taruhan (wager mode, v2): mode BARU yang tidak mengganti mode klasik.
 * Saat room.options.wagerMode true, tiap kartu punya fase 'wager' tambahan
 * SEBELUM fase 'question' - peserta pasang taruhan (blind bet) sebelum soal
 * ditampilkan. Pilihannya: stake tetap 25/50/100, PLUS dua pilihan dinamis
 * yang dihitung dari skor peserta saat itu - 'Setengah' (separuh skor,
 * dibulatkan ke atas) dan 'All In' (semua skor) - keduanya disembunyikan
 * kalau skor peserta masih 0 atau minus. Benar -> +stake (+bonus beruntun).
 * Salah -> -stake. Tidak menjawab sama sekali -> dianggap KALAH TARUHAN:
 * kehilangan stake penuh yang dipasang (bukan penalti flat), supaya diam
 * tidak pernah lebih menguntungkan daripada mencoba menjawab. Host juga
 * bisa pilih bantuan per soal: tanpa bantuan, tampilkan clue (dari bank
 * soal), atau 50:50 (hilangkan 2 dari 4 opsi salah).
 *
 * Comeback & floor skor (tambahan v2.1): skor peserta tidak akan pernah
 * turun di bawah SCORE_FLOOR, dan kalau peserta MASIH MINUS saat menjawab
 * BENAR di mode taruhan, stake yang didapat dikali COMEBACK_MULTIPLIER -
 * supaya yang lagi minus punya jalan cepat balik ke positif, bukan cuma
 * diam/males lanjut.
 *
 * Fitur seru mode klasik (v2.3): kartu TERAKHIR jadi "boss fight" (poin
 * jawaban benar dikali BOSS_MULTIPLIER) supaya peringkat masih bisa
 * berubah di menit akhir; pengumuman "ON FIRE" ke seluruh kelas saat
 * streak peserta mencapai milestone (STREAK_MILESTONES); dan info opsi
 * SALAH terpopuler di tiap reveal (mostPickedWrong) supaya host bisa
 * langsung membahas miskonsepsi kelas. Semuanya generik - berlaku untuk
 * bank soal & kategori soal apa pun.
 */
const { customAlphabet } = require('nanoid')

const TYPE_LABEL = {
	'predict-output': 'Tebak Output',
	'trace-path': 'Telusuri Cabang',
	'fix-bug': 'Cari Bug',
	pairing: 'Pasangkan',
}

// Label tim - dulu cuma 'A'/'B' hardcode (selalu 2 tim). Sekarang jumlah tim
// bisa diatur host lewat room.options.teamCount, dibatasi panjang array ini.
const TEAM_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

// Mode taruhan: pilihan stake TETAP yang bisa dipasang peserta (di luar dua
// pilihan dinamis 'Setengah'/'All In' berbasis skor - lihat wagerChoicesFor()
// di bawah), default kalau tidak pasang taruhan tepat waktu (blind bet
// auto-timeout), dan lama waktu fase pasang taruhan.
//
// CATATAN (perbaikan v2.2): dulu ada WAGER_NO_ANSWER_PENALTY = 10 (penalti
// flat kalau sudah pasang taruhan tapi tidak menjawab). Itu jadi celah:
// peserta yang All In lalu ragu setelah soal muncul memilih DIAM karena
// rugi 10 poin jauh lebih murah daripada salah jawab (-stake penuh).
// Sekarang tidak menjawab di mode taruhan = kalah stake penuh (lihat
// reveal()), jadi konstanta itu dihapus.
const WAGER_CHOICES = [25, 50, 100]
const WAGER_DEFAULT = 50
const WAGER_PICK_SECONDS = 10
const WAGER_HINT_LEVELS = ['none', 'clue', 'half']

// Floor skor & bonus comeback (tambahan v2.1): skor peserta tidak akan
// pernah turun di bawah SCORE_FLOOR, dan kalau peserta MASIH MINUS saat
// menjawab benar di mode taruhan, stake yang didapat dikali
// COMEBACK_MULTIPLIER - supaya yang lagi minus punya jalan cepat balik ke
// positif, bukan cuma diam/males lanjut.
const SCORE_FLOOR = -1000
const COMEBACK_MULTIPLIER = 2

// Fitur seru mode klasik (v2.3): pengali poin untuk kartu terakhir
// ("boss fight") dan milestone streak yang memicu pengumuman "ON FIRE".
const BOSS_MULTIPLIER = 2
const STREAK_MILESTONES = [3, 5, 7]

// Mode usil (v2.4): kalau dinyalakan host, sebagian kartu punya SATU opsi
// "pelari" yang kabur saat di-hover/ditap (maks 3x di klien) sebelum bisa
// dipilih. 50% pelari adalah opsi BENAR, 50% opsi salah acak - jadi larinya
// tidak membocorkan jawaban. Kartu ber-pelari dapat tambahan waktu sebagai
// kompensasi "pajak panik" terhadap bonus kecepatan.
const MISCHIEF_CARD_CHANCE = 0.35
const MISCHIEF_EXTRA_SECONDS = 5

function clampTeamCount(n) {
	return Math.min(TEAM_LETTERS.length, Math.max(2, Number(n) || 2))
}

function normalizeTeamScoreInterval(n) {
	return [3, 5, 7].includes(Number(n)) ? Number(n) : 5
}

const roomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4)
const genPid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8)

function shuffle(arr) {
	const a = arr.slice()
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
			;[a[i], a[j]] = [a[j], a[i]]
	}
	return a
}

// Ubah skor peserta sejumlah `delta`, dijaga supaya tidak pernah turun di
// bawah SCORE_FLOOR - dipakai di semua tempat yang mengubah player.score
// (submit jawaban, batal jawaban lama, penalti tidak menjawab di mode
// taruhan) supaya floornya konsisten di mana-mana.
function applyScoreDelta(player, delta) {
	player.score = Math.max(SCORE_FLOOR, player.score + delta)
}

/**
 * @param {Map<string, {id:string,label:string,questions:Array<object>}>} banks -
 *   bank soal, satu entri per file di folder banks/. Tiap file adalah satu
 *   "mata pelajaran" (mis. js-dasar.json, sql-dasar.json) dengan skema soal
 *   yang sama persis.
 * @param {string} defaultBank - id bank yang dipakai kalau room belum pilih
 *   satu, atau id yang dikirim klien ternyata tidak ada (mis. file dihapus).
 * @param {{ getJoinUrls: () => string[] }} deps - info jaringan untuk host
 */
function createGame(banks, defaultBank, deps) {
	const rooms = new Map()

	function bankIdFor(id) {
		return banks.has(id) ? id : defaultBank
	}

	function questionsFor(room) {
		return banks.get(bankIdFor(room.options.bank)).questions
	}

	function createRoom(hostConn, opts = {}) {
		let code = roomCode()
		while (rooms.has(code)) code = roomCode()

		const bank = bankIdFor(opts.bank)
		const room = {
			code,
			hosts: new Set([hostConn]),
			players: new Map(),
			phase: 'lobby',
			deck: [],
			index: -1,
			startedAt: 0,
			timer: null,
			// Dipakai hanya saat options.wagerMode true. hintLevel: bantuan yang
			// dipilih host untuk kartu SAAT INI. eliminated: index opsi salah
			// yang dibuang untuk hint 'half', dihitung sekali di fase 'wager'
			// lalu dipakai lagi di fase 'question' supaya konsisten.
			hintLevel: 'none',
			eliminated: null,
			// Index opsi "pelari" kartu saat ini (mode usil) - diputuskan sekali
			// per kartu di startQuestionPhase, bukan di cardPayload, supaya
			// peserta yang join ulang di tengah kartu dapat nilai yang sama.
			runner: null,
			options: {
				bank,
				teamMode: !!opts.teamMode,
				// Minimal 2, maksimal sejumlah huruf di TEAM_LETTERS - dulu selalu
				// tepat 2 (Tim A vs Tim B), sekarang bisa diatur host.
				teamCount: clampTeamCount(opts.teamCount),
				teamScoreInterval: normalizeTeamScoreInterval(opts.teamScoreInterval),
				shuffle: opts.shuffle !== false,
				count: Number(opts.count) || banks.get(bank).questions.length,
				types:
					Array.isArray(opts.types) && opts.types.length ? opts.types : null,
				// Mode baru, tidak menggantikan mode klasik - default mati.
				wagerMode: !!opts.wagerMode,
				// Mode usil (v2.4): opsi jawaban "pelari" - default mati juga.
				mischiefMode: !!opts.mischiefMode,
			},
		}
		rooms.set(code, room)
		return room
	}

	function buildDeck(room) {
		const source = questionsFor(room)
		let pool = source.slice()
		if (room.options.types) {
			pool = pool.filter((q) => room.options.types.includes(q.type))
		}
		if (!pool.length) pool = source.slice()
		pool = room.options.shuffle ? shuffle(pool) : pool
		room.deck = pool.slice(0, Math.max(1, room.options.count))
	}

	function broadcast(room, msg, who = 'all') {
		if (who === 'all' || who === 'host') for (const h of room.hosts) h.send(msg)
		if (who === 'all' || who === 'players')
			for (const p of room.players.values()) for (const c of p.conns) c.send(msg)
	}

	function leaderboard(room) {
		return [...room.players.values()]
			.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
			.map((p, i) => ({
				rank: i + 1,
				pid: p.pid,
				name: p.name,
				team: p.team,
				score: p.score,
				streak: p.streak,
				correct: p.correct,
				online: p.conns.size > 0,
			}))
	}

	function teamLetters(room) {
		return TEAM_LETTERS.slice(0, room.options.teamCount)
	}

	// function teamTotals(room) {
	// 	const t = {}
	// 	for (const letter of teamLetters(room)) t[letter] = 0
	// 	for (const p of room.players.values()) {
	// 		if (p.team && t[p.team] !== undefined) t[p.team] += p.score
	// 	}
	// 	return t
	// }

	function teamTotals(room) {
		const totals = {}
		const counts = {}

		for (const letter of teamLetters(room)) {
			totals[letter] = 0
			counts[letter] = 0
		}

		for (const player of room.players.values()) {
			if (player.team && totals[player.team] !== undefined) {
				totals[player.team] += player.score
				counts[player.team] += 1
			}
		}

		for (const letter of teamLetters(room)) {
			totals[letter] = counts[letter]
				? Math.round(totals[letter] / counts[letter])
				: 0
		}

		return totals
	}

	// Tim dengan anggota paling sedikit dapat peserta baru - kalau beberapa
	// tim seri jumlahnya, dipilih ACAK di antara yang seri (bukan selalu
	// balik ke Tim A) supaya pembagian terasa lebih dinamis, tidak
	// selang-seling kaku berdasarkan urutan gabung semata.
	function assignTeam(room) {
		const letters = teamLetters(room)
		const counts = {}
		for (const l of letters) counts[l] = 0
		for (const p of room.players.values()) {
			if (p.team && counts[p.team] !== undefined) counts[p.team] += 1
		}
		const min = Math.min(...letters.map((l) => counts[l]))
		const candidates = letters.filter((l) => counts[l] === min)
		return candidates[Math.floor(Math.random() * candidates.length)]
	}

	// Kocok ulang SEMUA peserta ke tim yang ada - acak tapi tetap rata
	// jumlahnya (selisih maksimal 1 orang antar tim). Dipakai saat host
	// menekan tombol "Kocok ulang tim", dan otomatis saat mode tim baru
	// dinyalakan atau jumlah tim berubah.
	function shuffleTeams(room) {
		const letters = teamLetters(room)
		const order = shuffle([...room.players.values()])
		order.forEach((p, i) => {
			p.team = letters[i % letters.length]
		})
	}

	function sendRoster(room) {
		broadcast(room, {
			t: 'roster',
			phase: room.phase,
			players: leaderboard(room),
			teams: room.options.teamMode ? teamTotals(room) : null,
			teamMode: room.options.teamMode,
			wagerMode: room.options.wagerMode,
		})
	}

	function startGame(room, hintLevel) {
		if (!room.players.size) return
		buildDeck(room)
		room.index = -1
		for (const p of room.players.values()) {
			p.score = 0
			p.streak = 0
			p.correct = 0
			p.wager = null
		}
		nextCard(room, hintLevel)
	}

	// Kartu terakhir di deck = "boss fight": poin jawaban benar mode klasik
	// dikali BOSS_MULTIPLIER (lihat submitAnswer). Deck 1 soal tidak dihitung
	// boss - tidak seru kalau semua soal jadi boss.
	function isBossCard(room) {
		return room.deck.length > 1 && room.index === room.deck.length - 1
	}

	function cardPayload(room, q, timeLimit) {
		return {
			t: 'card',
			index: room.index,
			total: room.deck.length,
			id: q.id,
			type: q.type,
			typeLabel: TYPE_LABEL[q.type] || q.type,
			level: q.level,
			prompt: q.prompt,
			code: q.code,
			// Bahasa untuk syntax highlighting di klien ('js' default supaya soal
			// lama tanpa field ini tetap tampil seperti sebelumnya).
			lang: q.lang || 'js',
			options: q.options,
			// Index opsi yang sudah dibuang oleh hint 50:50 di fase 'wager' -
			// null di luar mode taruhan atau kalau hint bukan 'half'.
			eliminated: room.options.wagerMode ? room.eliminated : null,
			// Flag "boss fight" - dipakai klien untuk menampilkan banner/bedakan
			// suasana kartu terakhir.
			boss: isBossCard(room),
			// Mode usil: index opsi "pelari" untuk kartu ini (atau null). Klien
			// yang menggerakkan tombolnya; server cuma memutuskan opsi mana.
			runner: room.options.mischiefMode ? room.runner : null,
			timeLimit,
			serverNow: Date.now(),
		}
	}

	function nextCard(room, hintLevel) {
		clearTimeout(room.timer)
		room.index += 1
		if (room.index >= room.deck.length) return endGame(room)

		const q = room.deck[room.index]
		if (room.options.wagerMode) {
			startWagerPhase(room, q, hintLevel)
		} else {
			startQuestionPhase(room, q)
		}
	}

	// Fase taruhan: cuma jalan kalau options.wagerMode true. Peserta pasang
	// taruhan (25/50/100/Setengah/All In) SEBELUM soal ditampilkan (blind
	// bet). Kalau host pilih bantuan 'half', 2 dari opsi salah sudah dibuang
	// sejak fase ini juga (disimpan di room.eliminated) supaya konsisten
	// untuk semua peserta dan tetap dipakai lagi nanti di fase 'question'.
	function startWagerPhase(room, q, hintLevel) {
		room.phase = 'wager'
		room.hintLevel = WAGER_HINT_LEVELS.includes(hintLevel) ? hintLevel : 'none'
		room.startedAt = Date.now()
		for (const p of room.players.values()) p.wager = null
		room.eliminated = room.hintLevel === 'half' ? pickEliminated(q) : null

		const common = {
			t: 'wager',
			index: room.index,
			total: room.deck.length,
			defaultStake: WAGER_DEFAULT,
			pickSeconds: WAGER_PICK_SECONDS,
			hintLevel: room.hintLevel,
			clue: room.hintLevel === 'clue' ? q.clue || null : null,
			// Untuk 'half': kirim teks opsi (minus yang tereliminasi) TANPA
			// prompt/kode soal - peserta tetap blind soal isinya, cuma
			// pilihannya yang menyempit jadi 2.
			options: room.hintLevel === 'half' ? q.options : null,
			eliminated: room.eliminated,
			serverNow: Date.now(),
		}
		// Host cuma butuh info bantuan untuk kartu ini, bukan daftar pilihan
		// stake - yang beda-beda per peserta tergantung skor masing-masing.
		broadcast(room, common, 'host')
		// Pilihan stake dikirim PER PESERTA: selain 25/50/100 yang sama untuk
		// semua orang, ada juga 'Setengah' & 'All In' yang nilainya dihitung
		// dari skor peserta itu sendiri saat ini (lihat wagerChoicesFor()).
		for (const p of room.players.values()) {
			const msg = Object.assign({}, common, { choices: wagerChoicesFor(p) })
			for (const c of p.conns) c.send(msg)
		}
		broadcast(room, { t: 'progress', answered: 0, total: room.players.size }, 'host')

		room.timer = setTimeout(() => {
			for (const p of room.players.values()) {
				if (!p.wager) p.wager = { stake: WAGER_DEFAULT, auto: true }
			}
			startQuestionPhase(room, q)
		}, WAGER_PICK_SECONDS * 1000 + 500)
	}

	// Mode usil (v2.4): pilih SATU opsi "pelari" untuk kartu ini. Hanya
	// sebagian kartu yang dapat pelari (MISCHIEF_CARD_CHANCE) supaya tetap
	// mengejutkan; 50% pelari adalah opsi BENAR, 50% opsi salah acak -
	// jadi larinya tidak bisa dijadikan petunjuk jawaban. Keputusan dibuat
	// di server karena klien tidak tahu kunci jawaban sebelum reveal.
	function pickRunner(q) {
		if (Math.random() >= MISCHIEF_CARD_CHANCE) return null
		if (Math.random() < 0.5) return q.answer
		const wrong = q.options.map((_, i) => i).filter((i) => i !== q.answer)
		if (!wrong.length) return null
		return wrong[Math.floor(Math.random() * wrong.length)]
	}

	// Pilih 2 dari opsi SALAH untuk dibuang (hint 'half' / 50:50) - selalu
	// menyisakan tepat opsi benar + 1 opsi salah, dipilih acak di antara opsi
	// salah supaya tidak selalu opsi salah yang sama yang tersisa.
	function pickEliminated(q) {
		const wrong = q.options.map((_, i) => i).filter((i) => i !== q.answer)
		return shuffle(wrong).slice(0, Math.max(0, q.options.length - 2))
	}

	// Pilihan taruhan untuk SATU peserta: stake tetap (WAGER_CHOICES) + dua
	// pilihan dinamis berbasis skor peserta SAAT INI - 'half' (setengah skor,
	// dibulatkan ke atas) dan 'all_in' (semua skor). Dihitung di server
	// (bukan dipercayakan ke klien) supaya tidak bisa dimanipulasi. Kalau
	// skor peserta 0 atau minus, kedua opsi dinamis ini disembunyikan - tidak
	// ada artinya bertaruh dari nol/utang.
	function wagerChoicesFor(player) {
		const choices = WAGER_CHOICES.map((v) => ({
			stake: v,
			kind: 'fixed',
			label: v + ' poin',
		}))
		if (player.score > 0) {
			const half = Math.ceil(player.score / 2)
			choices.push({ stake: half, kind: 'half', label: 'Setengah (' + half + ')' })
			choices.push({
				stake: player.score,
				kind: 'all_in',
				label: 'All In (' + player.score + ')',
			})
		}
		return choices
	}

	// Fase soal biasa - persis logika nextCard() versi sebelum mode taruhan
	// ada, cuma dipindah ke fungsi sendiri supaya bisa dipanggil baik
	// langsung dari nextCard() (mode klasik) maupun setelah fase 'wager'
	// (mode taruhan).
	// Batas waktu efektif kartu (ms): timeLimit soal + tambahan waktu kalau
	// kartu ini punya opsi "pelari" (mode usil) sebagai kompensasi "pajak
	// panik" - dipakai konsisten oleh startQuestionPhase, submitAnswer, dan
	// payload untuk peserta yang join ulang di tengah kartu.
	function effectiveLimitMs(room, q) {
		const extra = room.runner != null ? MISCHIEF_EXTRA_SECONDS : 0
		return ((q.timeLimit || 20) + extra) * 1000
	}

	function startQuestionPhase(room, q) {
		room.phase = 'question'
		room.startedAt = Date.now()
		// Menandai apakah kartu ini sudah pernah mencapai "semua sudah jawab"
		// - dipakai submitAnswer() supaya penjadwalan reveal cepat cuma jalan
		// sekali, walau ada yang gonta-ganti pilihan setelahnya.
		room.allAnswered = false
		for (const p of room.players.values()) p.answer = null
		// Mode usil: pilih opsi "pelari" SEKALI di sini (bukan di cardPayload)
		// supaya konsisten untuk semua peserta, termasuk yang join ulang di
		// tengah kartu. null kalau mode usil mati atau kartu ini kebagian
		// tidak ada pelari.
		room.runner = room.options.mischiefMode ? pickRunner(q) : null

		// PENTING: kunci jawaban & pembahasan TIDAK pernah dikirim sebelum reveal.
		const limitMs = effectiveLimitMs(room, q)
		broadcast(room, cardPayload(room, q, limitMs / 1000))
		broadcast(
			room,
			{ t: 'progress', answered: 0, total: room.players.size },
			'host',
		)

		room.timer = setTimeout(() => reveal(room), limitMs + 700)
	}

	function submitAnswer(room, player, choice) {
		// Dulu ada `|| player.answer` di sini yang bikin jawaban terkunci
		// permanen sejak klik pertama. Sekarang dihapus supaya siswa bisa
		// ganti pilihan berkali-kali selama kartu belum dibuka (fase masih
		// 'question') dan belum lewat batas waktu.
		if (room.phase !== 'question') return
		const q = room.deck[room.index]
		// Pakai batas efektif (termasuk tambahan waktu kartu ber-pelari) supaya
		// jawaban di detik tambahan tidak malah ditolak.
		const limit = effectiveLimitMs(room, q)
		const elapsed = Date.now() - room.startedAt
		if (elapsed > limit + 1500) return

		// Kalau ini bukan jawaban pertama untuk kartu ini, batalkan dulu poin
		// dari jawaban lama supaya tidak dobel hitung. Streak/jumlah-benar
		// SENGAJA tidak diubah di sini - itu baru difinalisasi sekali di
		// reveal(), berdasarkan pilihan FINAL, biar bonus beruntun tidak salah
		// hitung akibat gonta-ganti pilihan dalam satu kartu yang sama.
		if (player.answer) applyScoreDelta(player, -player.answer.points)

		const correct = choice === q.answer
		let points = 0
		// Rincian skor disimpan (bukan cuma totalnya) supaya nanti bisa
		// ditunjukkan balik ke siswa - biar mereka lihat sendiri kenapa poin
		// mereka segitu, bukan cuma percaya angka akhir.
		let breakdown = null
		if (room.options.wagerMode) {
			// Skor mode taruhan: pakai stake yang dipasang di fase 'wager' (atau
			// default WAGER_DEFAULT kalau auto-timeout, tidak pasang tepat
			// waktu). Benar -> +stake (x2 kalau lagi comeback dari minus) +
			// bonus beruntun (bonus kecepatan classic SENGAJA tidak dipakai di
			// mode ini). Salah -> -stake polos.
			const stake = (player.wager && player.wager.stake) || WAGER_DEFAULT
			const comeback = correct && player.score < 0
			if (correct) {
				const streakBonus = Math.min(player.streak * 10, 50)
				const stakeGain = comeback ? stake * COMEBACK_MULTIPLIER : stake
				points = stakeGain + streakBonus
				breakdown = { stake, streakBonus, comeback: comeback || undefined }
			} else {
				points = -stake
				breakdown = { stake, streakBonus: 0 }
			}
		} else if (correct) {
			// Bonus kecepatan selalu dihitung dari waktu jawaban TERBARU (kalau
			// diganti, dihitung ulang dari waktu ganti itu, bukan dari klik
			// pertama).
			const speed = Math.max(0, 1 - elapsed / limit)
			const speedBonus = Math.round(speed * 100)
			const streakBonus = Math.min(player.streak * 10, 50)
			const base = 100
			points = base + speedBonus + streakBonus
			breakdown = { base, speedBonus, streakBonus }
			// Boss fight: kartu terakhir, poin jawaban benar dikali
			// BOSS_MULTIPLIER supaya peringkat masih bisa berubah di menit
			// akhir - peserta yang ketinggalan punya alasan tetap fokus.
			if (isBossCard(room)) {
				points *= BOSS_MULTIPLIER
				breakdown.bossMultiplier = BOSS_MULTIPLIER
			}
		}
		applyScoreDelta(player, points)
		player.answer = { choice, correct, points, ms: elapsed, breakdown }

		for (const c of player.conns) c.send({ t: 'ack', choice, waiting: true })

		const answered = [...room.players.values()].filter((p) => p.answer).length
		broadcast(room, { t: 'progress', answered, total: room.players.size }, 'host')
		// Jadwalkan reveal 600ms setelah SEMUA sudah jawab - tapi cuma sekali
		// per kartu (`room.allAnswered`). Tanpa penjaga ini, siswa yang terus
		// gonta-ganti pilihan setelah satu kelas selesai bisa menunda-nunda
		// pembukaan jawaban tanpa batas.
		if (answered >= room.players.size && !room.allAnswered) {
			room.allAnswered = true
			clearTimeout(room.timer)
			room.timer = setTimeout(() => reveal(room), 600)
		}
	}

	function reveal(room) {
		if (room.phase !== 'question') return
		clearTimeout(room.timer)
		room.phase = 'reveal'
		const q = room.deck[room.index]

		// Finalisasi streak & jumlah-benar sekali di sini, berdasarkan pilihan
		// FINAL tiap siswa (setelah kemungkinan ganti pilihan beberapa kali).
		// Siswa yang tidak menjawab sama sekali: streak TIDAK diubah, sama
		// seperti perilaku sebelumnya - kecuali di mode taruhan, di mana
		// sudah pasang taruhan tapi tidak menjawab dianggap KALAH TARUHAN:
		// kehilangan stake PENUH & streak direset. Dulu cuma penalti flat -10,
		// yang bikin diam jadi pilihan "aman" saat ragu setelah All In -
		// sekarang diam TIDAK PERNAH lebih baik daripada mencoba menjawab.
		// Peserta yang streak-nya baru saja mencapai milestone di kartu ini -
		// diumumkan ke seluruh kelas lewat pesan 'reveal' (hotStreaks).
		const hotStreaks = []
		for (const p of room.players.values()) {
			if (!p.answer) {
				if (room.options.wagerMode) {
					const stake = (p.wager && p.wager.stake) || WAGER_DEFAULT
					applyScoreDelta(p, -stake)
					p.streak = 0
					// Transient, dibaca di loop 'result' di bawah lalu dihapus -
					// TIDAK menyentuh p.answer supaya klien tetap bisa membedakan
					// "tidak menjawab" dari "menjawab salah".
					p.noAnswerPenalty = stake
				}
				continue
			}
			if (p.answer.correct) {
				p.streak += 1
				p.correct += 1
				if (STREAK_MILESTONES.includes(p.streak))
					hotStreaks.push({ name: p.name, streak: p.streak })
			} else {
				p.streak = 0
			}
		}

		const stats = q.options.map(() => 0)
		for (const p of room.players.values()) {
			if (p.answer && stats[p.answer.choice] !== undefined)
				stats[p.answer.choice] += 1
		}

		// Opsi SALAH yang paling banyak dipilih di kartu ini - dipakai host
		// untuk langsung membahas miskonsepsi kelas ("70% pilih B padahal
		// kuncinya C, yuk bahas kenapa"). null kalau tidak ada yang salah.
		let mostPickedWrong = null
		for (let i = 0; i < stats.length; i++) {
			if (i === q.answer || stats[i] === 0) continue
			if (!mostPickedWrong || stats[i] > mostPickedWrong.count)
				mostPickedWrong = { option: i, count: stats[i] }
		}

		// Daftar yang paling cepat DAN benar - ditampilkan ke seluruh kelas di
		// layar guru, supaya kalau ada yang merasa "aku lebih cepat kok",
		// semua bisa lihat langsung urutan waktu jawab yang sebenarnya.
		const fastest = [...room.players.values()]
			.filter((p) => p.answer && p.answer.correct)
			.sort((a, b) => a.answer.ms - b.answer.ms)
			.slice(0, 3)
			.map((p) => ({ name: p.name, team: p.team, ms: p.answer.ms }))

		broadcast(room, {
			t: 'reveal',
			index: room.index,
			answer: q.answer,
			explanation: q.explanation,
			stats,
			hotStreaks,
			mostPickedWrong,
			boss: isBossCard(room),
			responders: [...room.players.values()].filter((p) => p.answer).length,
			leaderboard: leaderboard(room).slice(0, 10),
			teams: room.options.teamMode ? teamTotals(room) : null,
			teamScoreInterval: room.options.teamMode
				? room.options.teamScoreInterval
				: null,
			isLast: room.index >= room.deck.length - 1,
			fastest,
		})

		const board = leaderboard(room)
		for (const p of room.players.values()) {
			for (const c of p.conns) {
				c.send({
					t: 'result',
					answer: q.answer,
					explanation: q.explanation,
					correct: !!(p.answer && p.answer.correct),
					answered: !!p.answer,
					choice: p.answer ? p.answer.choice : null,
					points: p.answer ? p.answer.points : p.noAnswerPenalty ? -p.noAnswerPenalty : 0,
					// Rincian poin & waktu jawab (ms) - dipakai klien untuk
					// menjelaskan ke siswa kenapa poinnya segitu.
					breakdown: p.answer ? p.answer.breakdown : null,
					ms: p.answer ? p.answer.ms : null,
					score: p.score,
					streak: p.streak,
					rank: (board.find((x) => x.pid === p.pid) || {}).rank || null,
					of: room.players.size,
					// Hanya terisi di mode taruhan, untuk peserta yang sudah pasang
					// taruhan tapi tidak sempat/tidak mau menjawab sama sekali.
					wagerNoAnswerPenalty: p.noAnswerPenalty || null,
				})
			}
			delete p.noAnswerPenalty
		}
	}

	function endGame(room) {
		room.phase = 'ended'
		clearTimeout(room.timer)
		broadcast(room, {
			t: 'end',
			leaderboard: leaderboard(room),
			teams: room.options.teamMode ? teamTotals(room) : null,
			total: room.deck.length,
		})
	}

	function hostInfo(r) {
		return {
			t: 'room',
			code: r.code,
			joinUrls: deps.getJoinUrls(),
			available: questionsFor(r).length,
			banks: [...banks.values()].map((b) => ({
				id: b.id,
				label: b.label,
				count: b.questions.length,
			})),
			options: r.options,
		}
	}

	function handle(conn, msg) {
		const room = rooms.get(conn.data.code)

		switch (msg.t) {
			case 'host:create': {
				const r = createRoom(conn, msg.options || {})
				conn.data = { role: 'host', code: r.code }
				conn.send(hostInfo(r))
				sendRoster(r)
				return
			}

			case 'host:resume': {
				const r = rooms.get(String(msg.code || '').toUpperCase())
				if (!r)
					return conn.send({ t: 'error', message: 'Room sudah tidak aktif.' })
				r.hosts.add(conn)
				conn.data = { role: 'host', code: r.code }
				conn.send(hostInfo(r))
				sendRoster(r)
				return
			}

			case 'player:join': {
				const code = String(msg.code || '')
					.toUpperCase()
					.trim()
				const r = rooms.get(code)
				if (!r)
					return conn.send({ t: 'error', message: 'Kode room tidak ditemukan.' })

				const name =
					String(msg.name || '')
						.trim()
						.slice(0, 20) || 'Anonim'

				let player = msg.pid ? r.players.get(msg.pid) : null
				if (!player) {
					const taken = [...r.players.values()].some(
						(p) => p.name.toLowerCase() === name.toLowerCase(),
					)
					if (taken)
						return conn.send({
							t: 'error',
							message: 'Nama sudah dipakai, ganti ya.',
						})
					player = {
						pid: genPid(),
						name,
						team: r.options.teamMode ? assignTeam(r) : null,
						score: 0,
						streak: 0,
						correct: 0,
						answer: null,
						wager: null,
						conns: new Set(),
					}
					r.players.set(player.pid, player)
				}
				player.conns.add(conn)
				conn.data = { role: 'player', code: r.code, pid: player.pid }

				conn.send({
					t: 'joined',
					pid: player.pid,
					code: r.code,
					name: player.name,
					team: player.team,
					score: player.score,
					phase: r.phase,
				})

				if (r.phase === 'question') {
					const q = r.deck[r.index]
					const elapsed = Math.round((Date.now() - r.startedAt) / 1000)
					conn.send(
						cardPayload(r, q, Math.max(1, effectiveLimitMs(r, q) / 1000 - elapsed)),
					)
					if (player.answer)
						conn.send({ t: 'ack', choice: player.answer.choice, waiting: true })
				} else if (r.phase === 'ended') {
					conn.send({
						t: 'end',
						leaderboard: leaderboard(r),
						total: r.deck.length,
					})
				}
				sendRoster(r)
				return
			}

			case 'player:answer': {
				if (!room || conn.data.role !== 'player') return
				const p = room.players.get(conn.data.pid)
				if (p) submitAnswer(room, p, Number(msg.choice))
				return
			}

			case 'player:wager': {
				// Kunci taruhan peserta selama fase 'wager' masih berjalan - bisa
				// diganti berkali-kali sebelum waktunya habis, sama seperti
				// jawaban di fase 'question'.
				if (!room || conn.data.role !== 'player' || room.phase !== 'wager') return
				const p = room.players.get(conn.data.pid)
				if (!p) return
				// Validasi ulang di server terhadap pilihan yang SEHARUSNYA berlaku
				// untuk peserta ini saat ini (bukan cuma daftar tetap) - supaya
				// stake 'Setengah'/'All In' juga tervalidasi benar dan klien tidak
				// bisa mengirim angka sembarangan.
				const allowed = wagerChoicesFor(p).map((c) => c.stake)
				const requested = Number(msg.stake)
				const stake = allowed.includes(requested) ? requested : WAGER_DEFAULT
				p.wager = { stake, auto: false }
				for (const c of p.conns) c.send({ t: 'wagerAck', stake })
				const picked = [...room.players.values()].filter((x) => x.wager).length
				broadcast(room, { t: 'progress', answered: picked, total: room.players.size }, 'host')
				return
			}

			case 'host:options': {
				if (!room || conn.data.role !== 'host') return
				const prevBank = room.options.bank
				const prevTeamMode = room.options.teamMode
				const prevTeamCount = room.options.teamCount
				Object.assign(room.options, msg.options || {})
				room.options.bank = bankIdFor(room.options.bank)
				room.options.teamCount = clampTeamCount(room.options.teamCount)
				room.options.teamScoreInterval = normalizeTeamScoreInterval(
					room.options.teamScoreInterval,
				)
				if (room.options.teamMode) {
					// Kocok ulang otomatis HANYA saat mode tim baru dinyalakan atau
					// jumlah tim berubah (tim lama bisa jadi tidak valid lagi) -
					// supaya hasil "Kocok ulang tim" manual / pemindahan manual host
					// tidak ketimpa cuma gara-gara host ganti opsi lain (mis. bank
					// soal / jumlah soal).
					if (!prevTeamMode || room.options.teamCount !== prevTeamCount) {
						shuffleTeams(room)
					}
				} else {
					for (const p of room.players.values()) p.team = null
				}
				// Ganti bank -> jumlah soal tersedia berubah, kabari host lagi biar
				// batas atas input "Jumlah soal" ikut ter-update.
				if (room.options.bank !== prevBank) conn.send(hostInfo(room))
				sendRoster(room)
				return
			}

			case 'host:start':
				// msg.hint: level bantuan ('none'|'clue'|'half') untuk kartu
				// PERTAMA - cuma dipakai kalau room.options.wagerMode true.
				if (room && conn.data.role === 'host') startGame(room, msg.hint)
				return

			case 'host:next':
				// msg.hint: level bantuan untuk kartu berikutnya, dipilih ulang
				// oleh host setiap kali (lihat public/host.html).
				if (room && conn.data.role === 'host') nextCard(room, msg.hint)
				return

			case 'host:reveal':
				if (room && conn.data.role === 'host') reveal(room)
				return

			case 'host:kick':
				if (room && conn.data.role === 'host') {
					room.players.delete(msg.pid)
					sendRoster(room)
				}
				return

			case 'host:shuffleTeams':
				if (room && conn.data.role === 'host' && room.options.teamMode) {
					shuffleTeams(room)
					sendRoster(room)
				}
				return

			case 'host:setTeam': {
				if (!room || conn.data.role !== 'host' || !room.options.teamMode) return
				const p = room.players.get(msg.pid)
				const letters = teamLetters(room)
				if (p && letters.includes(msg.team)) {
					p.team = msg.team
					sendRoster(room)
				}
				return
			}

			case 'host:restart':
				if (room && conn.data.role === 'host') {
					room.phase = 'lobby'
					room.index = -1
					clearTimeout(room.timer)
					for (const p of room.players.values()) {
						p.score = 0
						p.streak = 0
						p.correct = 0
						p.answer = null
						p.wager = null
					}
					broadcast(room, { t: 'lobby' })
					sendRoster(room)
				}
				return

			case 'ping':
				conn.send({ t: 'pong' })
				return
		}
	}

	function onClose(conn) {
		const room = rooms.get(conn.data.code)
		if (!room) return
		if (conn.data.role === 'host') {
			room.hosts.delete(conn)
		} else if (conn.data.pid) {
			const p = room.players.get(conn.data.pid)
			if (p) {
				p.conns.delete(conn)
				sendRoster(room)
			}
		}
	}

	return { handle, onClose, rooms }
}

module.exports = { createGame }
