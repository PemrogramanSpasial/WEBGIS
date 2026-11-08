// js/saw.js — SAW dengan bobot AHP untuk WebGIS Wisata Kulon Progo
// Bobot kriteria dari AHP; preferensi/filter diisi user lewat pertanyaan interaktif.

/* ========== 1. KRITERIA & AHP ========== */

export const CRITERIA = [
  { code: 'C1', name: 'Waktu tempuh',    type: 'cost',    key: 'waktu_tempuh' }, // menit (OSRM)
  { code: 'C2', name: 'Biaya kunjungan', type: 'cost',    key: 'biaya' },        // Rp/orang (tiket + makan)
  { code: 'C3', name: 'Rating',          type: 'benefit', key: 'rating' },       // skala 1-5
  { code: 'C4', name: 'Jumlah ulasan',   type: 'benefit', key: 'ulasan' },       // ulasan
];

// Matriks perbandingan berpasangan (geomean 5 responden)
export const AHP_MATRIX = [
  [1,    2,    2, 4],
  [1/2,  1,    4, 4],
  [1/2,  1/4,  1, 1],
  [1/4,  1/4,  1, 1],
];

const RI = { 1: 0, 2: 0, 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41 };

/** Bobot AHP via geometric mean baris, dinormalisasi. */
export function ahpWeights(matrix = AHP_MATRIX) {
  const n = matrix.length;
  const gm = matrix.map(row => Math.pow(row.reduce((a, b) => a * b, 1), 1 / n));
  const sum = gm.reduce((a, b) => a + b, 0);
  return gm.map(g => g / sum);
}

/** Uji konsistensi AHP (CR <= 0.1 dianggap konsisten). */
export function ahpConsistency(matrix = AHP_MATRIX, w = ahpWeights(matrix)) {
  const n = matrix.length;
  const ratios = matrix.map((row, i) => row.reduce((s, v, j) => s + v * w[j], 0) / w[i]);
  const lambdaMax = ratios.reduce((a, b) => a + b, 0) / n;
  const CI = (lambdaMax - n) / (n - 1);
  const CR = RI[n] ? CI / RI[n] : 0;
  return { lambdaMax, CI, CR, consistent: CR <= 0.1 };
}

export const WEIGHTS = ahpWeights(); // [C1..C4] ≈ [0.4187, 0.3521, 0.1245, 0.1047]

/* ========== 2. PILIHAN PERTANYAAN INTERAKTIF ========== */

// Nilai pilihan di UI -> teks kolom `kategori` di database (null = Bebas)
export const KATEGORI = {
  alam:               'Wisata Alam',
  alam_buatan:        'Wisata Alam-Buatan',
  budaya_religi:      'Religi dan Budaya',   // di UI tertulis "Budaya dan Religi"
  agrowisata:         'Agrowisata',
  akomodasi_rekreasi: 'Akomodasi dan Rekreasi',
  bebas:              null,
};

export const CONFIG = {
  // Database belum punya durasi kunjungan -> pakai durasi minimal di lokasi (menit)
  durasiKunjungan: 60,
  // Waktu user dianggap termasuk perjalanan pulang-pergi
  roundTrip: true,
  // Estimasi makan dari rentang makan_min..makan_max: 'min' | 'mid' | 'max'
  makan: 'mid',
  osrmUrl: 'https://router.project-osrm.org',
  osrmChunk: 90,          // batas koordinat per request OSRM demo (100)
  fallbackSpeedKmh: 40,   // dipakai kalau OSRM gagal
  jumlahStop: 3,          // jumlah tempat dalam 1 rencana perjalanan
  kandidatPool: 10,       // top-N hasil SAW yang dicoba disusun jadi rute
};

/* ========== 3. DATA: GeoJSON -> alternatif ========== */

/** Biaya kunjungan per orang = tiket masuk + estimasi makan. (harga_paket tidak dipakai) */
export function hitungBiaya(p, cfg = CONFIG) {
  const tiket = p.harga_masuk ?? 0;
  const { makan_min: lo, makan_max: hi } = p;
  let makan = 0;
  if (lo != null && hi != null) makan = cfg.makan === 'min' ? lo : cfg.makan === 'max' ? hi : (lo + hi) / 2;
  else if (lo != null || hi != null) makan = lo ?? hi;
  return tiket + makan;
}

export function featureToAlt(f, cfg = CONFIG) {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  return {
    id: p.id, nama: p.nama, kategori: p.kategori, lat, lng,
    biaya: hitungBiaya(p, cfg),
    rating: p.rating,                 // bisa null (belum ada rating)
    ulasan: p.jumlah_ulasan ?? 0,
    durasi: cfg.durasiKunjungan,
    properties: p,
  };
}

/* ========== 4. WAKTU TEMPUH (OSRM) ========== */

function haversineKm(a, b) {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function osrmChunk(origin, dests, cfg) {
  const coords = [origin, ...dests].map(p => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${cfg.osrmUrl}/table/v1/driving/${coords}?sources=0&annotations=duration`);
  const json = await res.json();
  if (json.code !== 'Ok') throw new Error(json.code);
  return json.durations[0].slice(1).map(s => (s == null ? null : s / 60));
}

/** Waktu tempuh (menit) dari origin ke tiap tujuan. origin/tujuan: {lat, lng} */
export async function getTravelMinutes(origin, dests, cfg = CONFIG) {
  const out = [];
  try {
    for (let i = 0; i < dests.length; i += cfg.osrmChunk) {
      out.push(...await osrmChunk(origin, dests.slice(i, i + cfg.osrmChunk), cfg));
    }
    return out;
  } catch (err) {
    console.warn('OSRM gagal, pakai estimasi jarak lurus:', err.message);
    return dests.map(d => (haversineKm(origin, d) / cfg.fallbackSpeedKmh) * 60 * 1.3);
  }
}

/* ========== 5. FILTER (jawaban user) ========== */
// null = "Tidak dibatasi" / "Bebas" -> filter dilewati

export function filterKategori(alts, kategori) {
  const target = KATEGORI[kategori] ?? null;
  return target ? alts.filter(a => a.kategori === target) : alts;
}
export function filterRating(alts, ratingMin) {
  return ratingMin == null ? alts : alts.filter(a => a.rating != null && a.rating >= ratingMin);
}
export function filterAnggaran(alts, anggaran) {
  return anggaran == null ? alts : alts.filter(a => a.biaya <= anggaran);
}
export function filterWaktu(alts, waktuJam, cfg = CONFIG) {
  if (waktuJam == null) return alts;
  return alts.filter(a =>
    a.waktu_tempuh * (cfg.roundTrip ? 2 : 1) + a.durasi <= waktuJam * 60);
}

/* ========== 6. SAW ========== */

/** Normalisasi: benefit = x/max, cost = min/x */
export function normalize(alts, criteria = CRITERIA) {
  const val = (a, c) => a[c.key] ?? 0; // rating kosong dianggap 0
  const stat = {};
  criteria.forEach(c => {
    const v = alts.map(a => val(a, c));
    stat[c.key] = { min: Math.min(...v), max: Math.max(...v) };
  });
  return alts.map(a => {
    const r = {};
    criteria.forEach(c => {
      const x = val(a, c), { min, max } = stat[c.key];
      if (c.type === 'benefit') r[c.key] = max === 0 ? 0 : x / max;
      else r[c.key] = x === 0 ? 1 : min / x; // cost; gratis (0) = nilai terbaik
    });
    return r;
  });
}

/** Skor SAW = Σ (bobot × nilai normalisasi), urut dari terbesar. */
export function sawRank(alts, weights = WEIGHTS, criteria = CRITERIA) {
  const R = normalize(alts, criteria);
  return alts
    .map((a, i) => ({
      ...a,
      normalisasi: R[i],
      skor: criteria.reduce((s, c, j) => s + weights[j] * R[i][c.key], 0),
    }))
    .sort((x, y) => y.skor - x.skor)
    .map((a, i) => ({ ...a, peringkat: i + 1 }));
}

/* ========== 7. PIPELINE UTAMA ========== */

/**
 * @param {Object} geojson  data/wisata.geojson
 * @param {Object} input    {
 *   lokasi:    {lat, lng},                      // dari GPS / klik peta / geocoding
 *   kategori:  'alam'|'alam_buatan'|'budaya_religi'|'agrowisata'|'akomodasi_rekreasi'|'bebas',
 *   waktuJam:  number | null,                   // null = tidak dibatasi
 *   anggaran:  number | null,                   // Rp/orang, null = tidak dibatasi
 *   ratingMin: 3 | 3.5 | 4 | 4.5 | null         // null = tidak dibatasi
 * }
 * @returns {Promise<Array>} wisata terurut menurut skor SAW (kosong jika tidak ada yang lolos)
 */
export async function rekomendasiWisata(geojson, input, cfg = CONFIG) {
  let alts = geojson.features.map(f => featureToAlt(f, cfg));

  // Filter yang tidak butuh OSRM dulu (hemat request)
  alts = filterKategori(alts, input.kategori);
  alts = filterRating(alts, input.ratingMin);
  alts = filterAnggaran(alts, input.anggaran);
  if (!alts.length) return [];

  // Waktu tempuh dari lokasi user, lalu filter waktu
  const minutes = await getTravelMinutes(input.lokasi, alts, cfg);
  alts = alts
    .map((a, i) => ({ ...a, waktu_tempuh: minutes[i] }))
    .filter(a => a.waktu_tempuh != null);
  alts = filterWaktu(alts, input.waktuJam, cfg);
  if (!alts.length) return [];

  return sawRank(alts);
}

/* ========== 8. RENCANA PERJALANAN: 3 tempat berurutan + rute ========== */

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const toMenit = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? ''); return m ? +m[1] * 60 + +m[2] : null; };

/** true/false = buka/tutup saat tiba; null = data jam buka tidak tersedia */
export function statusBuka(p, tiba, durasi, hari) {
  if (p.hari_buka?.length && !p.hari_buka.includes(hari)) return false;
  if (p.buka_24jam) return true;
  const b = toMenit(p.jam_buka);
  let c = toMenit(p.jam_tutup);
  if (b == null || c == null) return null;
  if (c === 1439) c = 1440;     // "23:59" = tutup tengah malam
  if (c <= b) c += 1440;        // buka lewat tengah malam
  const t = tiba % 1440;
  return [t, t + 1440].some(x => x >= b && x + durasi <= c);
}

/** Matriks waktu tempuh (menit) antar semua titik. points: [{lat,lng}] */
export async function getDurationMatrix(points, cfg = CONFIG) {
  try {
    const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${cfg.osrmUrl}/table/v1/driving/${coords}?annotations=duration`);
    const json = await res.json();
    if (json.code !== 'Ok') throw new Error(json.code);
    return json.durations.map(row => row.map(s => (s == null ? Infinity : s / 60)));
  } catch (err) {
    console.warn('OSRM matrix gagal, pakai estimasi jarak lurus:', err.message);
    return points.map(a => points.map(b => (haversineKm(a, b) * 1.3 / cfg.fallbackSpeedKmh) * 60));
  }
}

/** Rute jalan (OSRM /route) melewati titik berurutan -> geometri + waktu/jarak tiap ruas */
export async function getRoute(points, cfg = CONFIG) {
  try {
    const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${cfg.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    const json = await res.json();
    if (json.code !== 'Ok') throw new Error(json.code);
    const r = json.routes[0];
    return {
      legs: r.legs.map(l => ({ menit: l.duration / 60, km: l.distance / 1000 })),
      geometry: r.geometry,
      estimasi: false,
    };
  } catch (err) {
    console.warn('OSRM route gagal, pakai garis lurus:', err.message);
    const legs = [], line = [[points[0].lng, points[0].lat]];
    for (let i = 0; i < points.length - 1; i++) {
      const km = haversineKm(points[i], points[i + 1]) * 1.3;
      legs.push({ menit: (km / cfg.fallbackSpeedKmh) * 60, km });
      line.push([points[i + 1].lng, points[i + 1].lat]);
    }
    return { legs, geometry: { type: 'LineString', coordinates: line }, estimasi: true };
  }
}

function* kombinasi(arr, k, start = 0, cur = []) {
  if (cur.length === k) { yield cur.slice(); return; }
  for (let i = start; i < arr.length; i++) {
    cur.push(arr[i]);
    yield* kombinasi(arr, k, i + 1, cur);
    cur.pop();
  }
}
function* permutasi(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutasi(rest)) yield [arr[i], ...p];
  }
}

// Total waktu: berangkat -> stop1 -> ... -> stopN (+ pulang) + durasi di tiap tempat.
// matrix: indeks 0 = titik awal, i+1 = kandidat[i]
function totalMenit(perm, matrix, cfg) {
  let t = matrix[0][perm[0] + 1];
  for (let k = 0; k < perm.length - 1; k++) t += matrix[perm[k] + 1][perm[k + 1] + 1];
  t += perm.length * cfg.durasiKunjungan;
  if (cfg.roundTrip) t += matrix[perm[perm.length - 1] + 1][0];
  return t;
}

/**
 * Pilih kombinasi tempat (utamakan jumlahStop) dengan total skor SAW terbesar yang muat
 * di waktu & anggaran, lalu urutkan agar total waktu tempuh paling kecil.
 * @returns {{urutan:number[], skor:number, total:number} | null}  urutan = indeks ke `kandidat`
 */
export function pilihItinerary(kandidat, matrix, input, cfg = CONFIG) {
  const batas = input.waktuJam == null ? Infinity : input.waktuJam * 60;
  const idx = kandidat.map((_, i) => i);
  for (let n = Math.min(cfg.jumlahStop, kandidat.length); n >= 1; n--) {
    let best = null;
    for (const kombo of kombinasi(idx, n)) {
      // anggaran = total tiket + makan seluruh tempat yang dikunjungi
      if (input.anggaran != null && kombo.reduce((s, i) => s + kandidat[i].biaya, 0) > input.anggaran) continue;
      const skor = kombo.reduce((s, i) => s + kandidat[i].skor, 0);
      for (const perm of permutasi(kombo)) {
        const total = totalMenit(perm, matrix, cfg);
        if (total > batas) continue;
        if (!best || skor > best.skor + 1e-12 || (Math.abs(skor - best.skor) <= 1e-12 && total < best.total)) {
          best = { urutan: perm, skor, total };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Rencana perjalanan lengkap.
 * input = input rekomendasiWisata + { jamBerangkat?: Date }
 * @returns {Promise<{stops:Array, pulang:Object|null, mulai:number, totalMenit:number,
 *   totalKm:number, totalBiaya:number, rute:Object, estimasi:boolean, pesan:string|null}>}
 */
export async function rencanaPerjalanan(geojson, input, cfg = CONFIG) {
  const kosong = pesan => ({ stops: [], pesan });

  const ranking = await rekomendasiWisata(geojson, input, cfg);
  if (!ranking.length) return kosong('Tidak ada wisata yang cocok. Coba longgarkan waktu, anggaran, atau rating.');

  const kandidat = ranking.slice(0, cfg.kandidatPool);
  const matrix = await getDurationMatrix([input.lokasi, ...kandidat], cfg);
  const pilih = pilihItinerary(kandidat, matrix, input, cfg);
  if (!pilih) return kosong('Waktu atau anggaran tidak cukup untuk mengunjungi satu tempat pun. Coba tambah waktu atau anggaran.');

  const terpilih = pilih.urutan.map(i => kandidat[i]);
  const titik = [input.lokasi, ...terpilih, ...(cfg.roundTrip ? [input.lokasi] : [])];
  const rute = await getRoute(titik, cfg);

  // Jadwal per tempat
  const base = input.jamBerangkat instanceof Date ? input.jamBerangkat : new Date();
  const mulai = base.getHours() * 60 + base.getMinutes();
  const hari = HARI[base.getDay()];
  let cursor = mulai;
  const stops = terpilih.map((s, i) => {
    const leg = rute.legs[i];
    const tiba = cursor + leg.menit;
    const selesai = tiba + cfg.durasiKunjungan;
    cursor = selesai;
    return {
      ...s, urutan: i + 1,
      perjalananMenit: leg.menit, perjalananKm: leg.km,
      tiba, selesai,
      buka: statusBuka(s.properties, tiba, cfg.durasiKunjungan, hari),
    };
  });

  let pulang = null;
  if (cfg.roundTrip) {
    const leg = rute.legs[rute.legs.length - 1];
    pulang = { menit: leg.menit, km: leg.km, tiba: cursor + leg.menit };
    cursor = pulang.tiba;
  }

  return {
    stops, pulang, mulai,
    totalMenit: cursor - mulai,
    totalKm: rute.legs.reduce((s, l) => s + l.km, 0),
    totalBiaya: stops.reduce((s, a) => s + a.biaya, 0),
    rute: rute.geometry,
    estimasi: rute.estimasi,
    pesan: stops.length < cfg.jumlahStop
      ? `Hanya ${stops.length} tempat yang muat dengan waktu/anggaran Anda (diminta ${cfg.jumlahStop}).`
      : null,
  };
}
