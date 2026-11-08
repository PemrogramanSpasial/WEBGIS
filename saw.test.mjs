// Jalankan: node saw.test.mjs   (taruh di folder yang sama dengan saw.js & wisata.geojson)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ahpWeights, ahpConsistency, sawRank, hitungBiaya, filterWaktu,
  pilihItinerary, statusBuka, rencanaPerjalanan, CONFIG,
} from './saw.js';

// --- AHP
const w = ahpWeights();
[0.4187, 0.3521, 0.1245, 0.1047].forEach((e, i) => assert.ok(Math.abs(w[i] - e) < 1e-4, `bobot C${i + 1}`));
assert.ok(Math.abs(ahpConsistency().CR - 0.068) < 1e-3, 'CR ~ 6.8%');

// --- biaya & SAW
assert.equal(hitungBiaya({ harga_masuk: 10000, makan_min: 25000, makan_max: 100000 }), 72500);
const r = sawRank([
  { waktu_tempuh: 30, biaya: 20000, rating: 4.5, ulasan: 1000 },
  { waktu_tempuh: 60, biaya: 10000, rating: 4.0, ulasan: 3000 },
  { waktu_tempuh: 20, biaya: 0, rating: null, ulasan: 0 },
]);
assert.ok(r.every(x => Number.isFinite(x.skor) && x.skor > 0 && x.skor <= 1));
assert.equal(filterWaktu([{ waktu_tempuh: 60, durasi: 60 }], 3).length, 1);
assert.equal(filterWaktu([{ waktu_tempuh: 61, durasi: 60 }], 3).length, 0);

// --- jam buka
assert.equal(statusBuka({ buka_24jam: true, hari_buka: [] }, 100, 60, 'Senin'), true);
assert.equal(statusBuka({ jam_buka: '08:00', jam_tutup: '17:00', hari_buka: [] }, 7 * 60, 60, 'Senin'), false);
assert.equal(statusBuka({ jam_buka: '08:00', jam_tutup: '17:00', hari_buka: [] }, 9 * 60, 60, 'Senin'), true);
assert.equal(statusBuka({ jam_buka: '08:00', jam_tutup: '17:00', hari_buka: [] }, 16.5 * 60, 60, 'Senin'), false); // selesai lewat tutup
assert.equal(statusBuka({ jam_buka: '08:00', jam_tutup: '17:00', hari_buka: ['Sabtu'] }, 9 * 60, 60, 'Senin'), false);
assert.equal(statusBuka({ hari_buka: [] }, 9 * 60, 60, 'Senin'), null);

// --- pilihItinerary: 3 titik segaris, urutan harus 1-2-3 (bukan acak)
const pos = [0, 1, 2, 3];                                     // 0 = titik awal
const matrix = pos.map(a => pos.map(b => Math.abs(a - b) * 10));
const kand = [{ biaya: 0, skor: 0.5 }, { biaya: 0, skor: 0.9 }, { biaya: 0, skor: 0.7 }];
const cfg0 = { ...CONFIG, roundTrip: false };
const pil = pilihItinerary(kand, matrix, { waktuJam: null, anggaran: null }, cfg0);
assert.deepEqual(pil.urutan, [0, 1, 2]);
assert.equal(pil.total, 30 + 3 * 60);
// waktu mepet: 1 jam 20 mnt -> hanya 1 tempat (10 + 60 = 70 <= 80)
const pil1 = pilihItinerary(kand, matrix, { waktuJam: 80 / 60, anggaran: null }, cfg0);
assert.equal(pil1.urutan.length, 1);
assert.deepEqual(pil1.urutan, [1]);                           // skor tertinggi yang muat
// anggaran total: 3 tempat @ 30rb > 60rb -> hanya 2
const mahal = kand.map(k => ({ ...k, biaya: 30000 }));
assert.equal(pilihItinerary(mahal, matrix, { waktuJam: null, anggaran: 60000 }, cfg0).urutan.length, 2);

// --- end-to-end data asli (OSRM dimatikan -> fallback jarak lurus)
globalThis.fetch = async () => { throw new Error('offline'); };
const warn = console.warn; console.warn = () => {};
const geo = JSON.parse(readFileSync(new URL('./wisata.geojson', import.meta.url)));
const wates = { lat: -7.8575, lng: 110.1597 };
const berangkat = new Date(2026, 10, 8, 9, 0);                // Minggu 09:00

const input = { lokasi: wates, kategori: 'alam', waktuJam: 6, anggaran: 100000, ratingMin: 4, jamBerangkat: berangkat };
const rc = await rencanaPerjalanan(geo, input);
assert.equal(rc.stops.length, 3, '3 rekomendasi');
assert.ok(rc.totalMenit <= 6 * 60 + 0.01, 'muat di waktu');
assert.ok(rc.totalBiaya <= 100000, 'muat di anggaran');
assert.equal(rc.mulai, 540);
assert.ok(rc.stops.every((s, i) => i === 0 || s.tiba >= rc.stops[i - 1].selesai), 'jadwal berurutan');
assert.ok(Math.abs(rc.stops[0].tiba - (540 + rc.stops[0].perjalananMenit)) < 1e-9);
assert.ok(rc.stops.every(s => s.selesai - s.tiba === 60), '1 jam per tempat');
assert.ok(Math.abs(rc.totalMenit - (rc.pulang.tiba - 540)) < 1e-9);
assert.equal(rc.rute.type, 'LineString');
assert.ok(rc.rute.coordinates.length >= 5);                   // awal + 3 stop + pulang

const sempit = await rencanaPerjalanan(geo, { ...input, waktuJam: 2 });
assert.ok(sempit.stops.length < 3 && sempit.pesan, 'waktu sempit -> kurang dari 3 + pesan');

const bebas = await rencanaPerjalanan(geo, { lokasi: wates, kategori: 'bebas', waktuJam: null, anggaran: null, ratingMin: null, jamBerangkat: berangkat });
assert.equal(bebas.stops.length, 3);

const nol = await rencanaPerjalanan(geo, { ...input, waktuJam: 0.5 });
assert.equal(nol.stops.length, 0);
console.warn = warn;

console.log('Semua test lolos.\n');
console.log(`Contoh: alam, 6 jam, <=Rp100rb, rating>=4, berangkat 09:00 dari Wates (estimasi garis lurus)`);
const f = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
rc.stops.forEach(s => console.log(`  ${s.urutan}. ${s.nama}  tiba ${f(s.tiba)} selesai ${f(s.selesai)}  (+${Math.round(s.perjalananMenit)} mnt, Rp${s.biaya}, skor ${s.skor.toFixed(3)}, buka=${s.buka})`));
console.log(`  pulang ${f(rc.pulang.tiba)} | total ${Math.round(rc.totalMenit)} mnt, ${rc.totalKm.toFixed(1)} km, Rp${rc.totalBiaya}`);
