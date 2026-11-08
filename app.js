// app.js — pertanyaan interaktif -> rencana perjalanan 3 tempat (SAW + rute OSRM) -> peta Leaflet
//
// ID elemen di index.html: #map, #btn-gps, #btn-peta, #btn-teks, #lokasi-teks, #lokasi-status,
// #kategori, #waktu, #waktu-bebas, #anggaran, #anggaran-bebas, #rating, #jam-berangkat, #btn-cari, #hasil
import { rencanaPerjalanan } from './saw.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupiah = n => 'Rp' + Math.round(n).toLocaleString('id-ID');
const fmtJam = m => { const x = Math.round(m) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const fmtDurasi = m => { m = Math.round(m); const j = Math.floor(m / 60), s = m % 60; return j ? `${j} jam ${s} mnt` : `${s} mnt`; };

const map = L.map('map').setView([-7.86, 110.15], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
}).addTo(map);

const layerHasil = L.layerGroup().addTo(map);
let lokasi = null, markerUser = null, geojsonCache = null, pilihPeta = false;

// Jam berangkat default = sekarang
const now = new Date();
$('jam-berangkat').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

/* ---------- Pertanyaan 1: Lokasi ---------- */
function setLokasi(lat, lng, label) {
  lokasi = { lat, lng };
  if (markerUser) map.removeLayer(markerUser);
  markerUser = L.circleMarker([lat, lng], { radius: 8, color: '#1d4ed8', fillOpacity: 0.9 })
    .addTo(map).bindPopup('Titik awal perjalanan');
  map.setView([lat, lng], 12);
  $('lokasi-status').textContent = `Lokasi: ${label} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

$('btn-gps').onclick = () => {
  if (!navigator.geolocation) return alert('Browser tidak mendukung geolokasi.');
  navigator.geolocation.getCurrentPosition(
    p => setLokasi(p.coords.latitude, p.coords.longitude, 'GPS'),
    () => alert('Gagal mengambil lokasi. Izinkan akses lokasi atau pilih cara lain.'),
    { enableHighAccuracy: true, timeout: 10000 });
};

$('btn-peta').onclick = () => {
  pilihPeta = true;
  $('lokasi-status').textContent = 'Klik pada peta untuk menentukan titik awal…';
  map.getContainer().style.cursor = 'crosshair';
};
map.on('click', e => {
  if (!pilihPeta) return;
  pilihPeta = false;
  map.getContainer().style.cursor = '';
  setLokasi(e.latlng.lat, e.latlng.lng, 'titik di peta');
});

$('btn-teks').onclick = async () => {
  const q = $('lokasi-teks').value.trim();
  if (!q) return alert('Ketik nama tempat/alamat dulu.');
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=id' +
      '&viewbox=109.7,-7.5,110.4,-8.1&q=' + encodeURIComponent(q);
    const [hit] = await (await fetch(url)).json();
    if (!hit) return alert('Lokasi tidak ditemukan. Coba nama yang lebih spesifik.');
    setLokasi(+hit.lat, +hit.lon, hit.display_name.split(',').slice(0, 2).join(','));
  } catch { alert('Gagal mencari lokasi. Cek koneksi internet.'); }
};

/* ---------- Pertanyaan 2-5 + jam berangkat ---------- */
function bacaInput() {
  const num = (id, bebasId) => ($(bebasId).checked || $(id).value === '') ? null : Number($(id).value);
  const jam = $('jam-berangkat').value;           // "HH:MM" atau kosong
  const berangkat = new Date();
  if (jam) { const [h, m] = jam.split(':').map(Number); berangkat.setHours(h, m, 0, 0); }
  return {
    lokasi,
    kategori: $('kategori').value,
    waktuJam: num('waktu', 'waktu-bebas'),
    anggaran: num('anggaran', 'anggaran-bebas'),
    ratingMin: $('rating').value === '' ? null : Number($('rating').value),
    jamBerangkat: berangkat,
  };
}

for (const k of ['waktu', 'anggaran']) {
  $(`${k}-bebas`).onchange = () => { $(k).disabled = $(`${k}-bebas`).checked; };
}

/* ---------- Hitung & tampilkan ---------- */
$('btn-cari').onclick = async () => {
  if (!lokasi) return alert('Tentukan lokasi awal dulu (GPS, peta, atau ketik lokasi).');
  $('btn-cari').disabled = true;
  $('hasil').textContent = 'Menyusun rencana perjalanan…';
  try {
    geojsonCache ??= await (await fetch('wisata.geojson')).json();
    tampilkan(await rencanaPerjalanan(geojsonCache, bacaInput()));
  } catch (err) {
    console.error(err);
    $('hasil').textContent = 'Terjadi kesalahan saat menghitung. Coba lagi.';
  } finally { $('btn-cari').disabled = false; }
};

function tampilkan(r) {
  layerHasil.clearLayers();
  const box = $('hasil');
  if (!r.stops.length) { box.textContent = r.pesan; return; }

  // Rute di peta
  const garis = L.geoJSON(r.rute, { style: { color: '#2563eb', weight: 5, opacity: 0.8 } }).addTo(layerHasil);
  const bounds = garis.getBounds().extend([lokasi.lat, lokasi.lng]);

  // Marker bernomor + daftar linimasa
  const markers = r.stops.map(s => {
    const p = s.properties;
    const info = `<b>${s.urutan}. ${esc(s.nama)}</b><br>${esc(s.kategori)} · ${esc(p.kapanewon)}<br>` +
      `Tiba ${fmtJam(s.tiba)} – selesai ${fmtJam(s.selesai)}<br>` +
      `💰 ${rupiah(s.biaya)}/orang · ⭐ ${s.rating ?? '-'} (${s.ulasan} ulasan)<br>Skor SAW: ${s.skor.toFixed(3)}` +
      (p.url_maps ? `<br><a href="${esc(p.url_maps)}" target="_blank" rel="noopener">Buka di Google Maps</a>` : '');
    const m = L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: '', iconSize: [28, 28],
        html: `<div style="background:#dc2626;color:#fff;border-radius:50%;width:28px;height:28px;line-height:28px;text-align:center;font-weight:700">${s.urutan}</div>` }),
    }).addTo(layerHasil).bindPopup(info);
    bounds.extend([s.lat, s.lng]);
    return m;
  });

  let html = `<div class="ringkasan"><b>${r.stops.length} tempat</b> · total ${fmtDurasi(r.totalMenit)} · ` +
    `${r.totalKm.toFixed(1)} km · ${rupiah(r.totalBiaya)}/orang</div>`;
  if (r.pesan) html += `<p class="catatan">${esc(r.pesan)}</p>`;
  if (r.estimasi) html += `<p class="catatan">⚠️ Layanan rute OSRM tidak bisa dihubungi; waktu & rute berupa estimasi garis lurus.</p>`;

  html += `<div class="tl"><div class="tl-titik">🏁 Berangkat <b>${fmtJam(r.mulai)}</b></div>`;
  r.stops.forEach((s, i) => {
    html += `<div class="tl-leg">🚗 ${fmtDurasi(s.perjalananMenit)} · ${s.perjalananKm.toFixed(1)} km</div>` +
      `<div class="tl-stop" data-i="${i}"><b>${s.urutan}. ${esc(s.nama)}</b><br>` +
      `<small>${fmtJam(s.tiba)}–${fmtJam(s.selesai)} · ${rupiah(s.biaya)} · ⭐ ${s.rating ?? '-'} · skor ${s.skor.toFixed(3)}</small>` +
      (s.buka === false ? `<br><span class="tutup">⚠️ Kemungkinan tutup saat Anda tiba</span>` : '') +
      `</div>`;
  });
  if (r.pulang) {
    html += `<div class="tl-leg">🚗 ${fmtDurasi(r.pulang.menit)} · ${r.pulang.km.toFixed(1)} km</div>` +
      `<div class="tl-titik">🏠 Kembali ke titik awal <b>${fmtJam(r.pulang.tiba)}</b></div>`;
  }
  html += `</div>`;
  box.innerHTML = html;

  box.querySelectorAll('.tl-stop').forEach(el => {
    el.onclick = () => {
      const m = markers[+el.dataset.i];
      map.setView(m.getLatLng(), 14);
      m.openPopup();
    };
  });
  map.fitBounds(bounds, { padding: [40, 40] });
}
