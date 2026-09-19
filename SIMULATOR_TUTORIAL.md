# 📖 Tutorial & Panduan Simulator Hardware STB HG680P / HG860P (Amlogic S905X)

Panduan lengkap penggunaan **Realtime Hardware & Thermal Simulator** NYX NVR untuk menguji beban komputasi CPU, konsumsi RAM, dan kurva suhu SoC pada Single Board Computer (SBC) STB HG680P / HG860P.

---

## 📌 1. Mengapa Simulator Ini Dibuat?

Menjalankan 2 stream CCTV 1080p RTSP bersamaan dengan AI Object Detection di STB berbasis **Amlogic S905X** (Quad-Core Cortex-A53 @ 1.5GHz, 2GB RAM, heatsink pasif) adalah beban kerja yang sangat ekstrem.

Jika sistem tidak dioptimalkan:
- 4 Core CPU akan terbebani **100% tanpa henti**.
- Suhu SoC akan melonjak melewati **$80^\circ\text{C}\text{--}85^\circ\text{C}$**.
- STB akan mengalami **thermal shutdown (mati mendadak)** atau kernel panic.

Simulator ini dibuat untuk:
1. **Menguji stabilitas beban & kurva suhu** secara aman di komputer tanpa risiko merusak hardware STB fisik.
2. **Membandingkan secara visual** perbedaan antara pipeline *Unoptimized* (penyebab STB mati) vs pipeline *NYX-Optimized* (INT8 + 416x256 + 1 Thread + Motion Gate).
3. **Memonitor metrik resource per Core CPU & konsumsi RAM** secara realtime (5 Hz / interval 200ms).

---

## ⚙️ 2. Spesifikasi Hardware SBC yang Dimodelkan

| Parameter | Spesifikasi Hardware Model |
| :--- | :--- |
| **Perangkat** | ZTE HG680-P / Fiberhome HG860P TV Box |
| **SoC / Prosesor** | Amlogic S905X (4x ARM Cortex-A53 @ 1.512 GHz) |
| **Total RAM** | 2048 MB LPDDR3 (Usable: ~1860 MB di Linux Armbian Bullseye Kernel 5.10) |
| **Sistem Pendingin** | Heatsink Aluminium Pasif di dalam Casing Plastik Tertutup |
| **Model Fisika Termal** | $T(t) = T_{amb} + (P_{watt} \times R_{thermal})$ ($R_{th} \approx 6.8^\circ\text{C}/\text{W}$, $T_{amb} \approx 38^\circ\text{C}$) |
| **Batas Suhu Aman** | $\le 68^\circ\text{C}$ (🟢 COOL) |
| **Batas Thermal Warning** | $\ge 75^\circ\text{C}$ (🟡 WARM / Force ECO Mode) |
| **Batas Emergency Trip** | $\ge 84^\circ\text{C}$ (💥 CRITICAL THERMAL SHUTDOWN) |

---

## 🚀 3. Cara Menjalankan Simulator

Pastikan dependensi proyek sudah terpasang. Jalankan perintah berikut di terminal:

```bash
npm run bench:stb
```

Atau menggunakan `ts-node` secara langsung:
```bash
npx ts-node scripts/simulate-stb.ts
```

---

## 🎮 4. Tombol Kontrol Interaktif di Terminal

Saat simulator berjalan, Anda dapat menekan tombol keyboard berikut secara langsung:

| Tombol | Aksi | Dampak pada Sistem |
| :---: | :--- | :--- |
| **`1`** | **Beralih ke Mode NYX-OPTIMIZED** | Mengaktifkan model INT8, resolusi 16:9 (416x256), kunci 1 thread, dan motion gating. CPU stabil di 35–48%, suhu aman $55\text{--}62^\circ\text{C}$. |
| **`2`** | **Beralih ke Mode UNOPTIMIZED** | Mensimulasikan pipeline lama: FP32 640x640, 4 thread, continuous inference tanpa motion gate. CPU langsung 100% dan suhu naik drastis menembus $80^\circ\text{C}$ hingga terjadi *Emergency Shutdown*. |
| **`M`** | **Manual Motion Event Trigger** | Mensimulasikan deteksi pergerakan objek/manusia di depan kamera, memicu burst AI Stage 2 selama 3 detik. |
| **`Q`** | **Exit Simulator** | Menutup simulator dan mengembalikan terminal ke mode normal. |

---

## 📊 5. Penjelasan Panel Metrik Terminal

Tampilan simulator terbagi menjadi beberapa blok informasi:

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║             NYX NVR - STB HG680P / HG860P REALTIME HARDWARE SIMULATOR                ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
```

### 1. Banner Status Mode
- **`[MODE: NYX-OPTIMIZED]`** (Hijau): Menandakan sistem berjalan dengan optimasi penuh.
- **`[MODE: UNOPTIMIZED]`** (Merah): Menandakan sistem menjalankan beban penuh tanpa batas thread.

### 2. Telemetri Suhu & Profil Termal (`🔥 THERMAL TELEMETRY`)
- **SoC Temperature**: Suhu prosesor saat ini beserta status (🟢 COOL / 🟡 WARM / 🔥 OVERHEATING / 💥 SHUTDOWN).
- **Thermal Curve**: Grafik sparkline dinamis `[ ▂▃▄▅▆▇█]` yang menggambarkan tren kenaikan atau penurunan suhu.
- **Power Draw Est.**: Estimasi konsumsi daya SoC dalam Watt berdasarkan kurva beban komputasi.

### 3. Distribusi Beban CPU (`⚡ CPU LOAD`)
- **Core 0 [AI Ingest]**: Beban pemrosesan tensor AI Stage 2 (hanya aktif saat ada gerakan jika dioptimalkan).
- **Core 1 [FFmpeg 1]**: Beban passthrough demuxing RTSP Kamera 1 (~4%).
- **Core 2 [FFmpeg 2]**: Beban passthrough demuxing RTSP Kamera 2 (~4%).
- **Core 3 [Node/OS]**: Beban event loop Fastify, WebSocket broadcast, dan SQLite.
- **Total CPU Load**: Rata-rata persentase penggunaan CPU dari seluruh 4 core.

### 4. Memori & RAM (`💾 MEMORY USAGE`)
- **System RAM Used**: Total RAM sistem terpakai dari kapasitas 1860MB usable.
- **Node.js RSS Memory**: Ukuran memori fisik proses Node.js (dibatasi di bawah 256MB).
- **V8 Heap Allocated**: Memori heap objek JavaScript.

### 5. AI Pipeline Telemetry (`📹 CAMERA & AI PIPELINE`)
- **Inference Latency**: Waktu kalkulasi satu frame AI dalam milidetik (INT8 416x256: ~35–45ms vs FP32 640x640: ~280–340ms).
- **Motion Triggers**: Jumlah event pergerakan yang memicu AI.
- **Dropped Frames**: Jumlah frame yang dibuang jika antrean buffer macet (pada mode NYX bernilai 0).

---

## 💡 6. Hasil Komparasi: Optimized vs Unoptimized

| Metrik Evaluasi | Mode Unoptimized (Penyebab Mati) | Mode NYX-Optimized (Sistem Saat Ini) |
| :--- | :--- | :--- |
| **Model & Resolusi** | YOLOv8n FP32 @ 640x640 | YOLOv8n INT8 @ 416x256 (16:9) |
| **Jumlah Elemen Tensor** | 1.228.800 Floats | 319.488 Floats (**Hemat 74%**) |
| **Alokasi Thread ONNX** | 4 Thread (Thread Contention) | 1 Thread (Bebas Perebutan Core) |
| **Strategi Eksekusi AI** | Continuous (Inference 24/7) | Motion-Gated (Inference saat ada objek) |
| **Rata-rata CPU Load** | **95% – 100% (Saturasi Penuh)** | **15% (Idle) / 38% – 48% (Saat Gerak)** |
| **Suhu SoC S905X** | **$80^\circ\text{C}\text{--}86^\circ\text{C}$ (Overheat/Mati)** | **$54^\circ\text{C}\text{--}62^\circ\text{C}$ (Dingin & Aman)** |
| **Inference Latency** | ~280ms – 340ms per frame | ~38ms – 45ms per frame |
| **Lag / Buffer Backlog** | Parah (Delay 10–30 detik) | **0 ms (Realtime / Zero Backlog)** |

---

## 🛠️ 7. Rekomendasi Praktis untuk Deployment di STB Fisik

1. **Gunakan Model INT8**:
   Konversi model bawaan Anda menggunakan script:
   ```bash
   npm run quantize
   ```
2. **Gunakan Sub-Stream untuk Kamera Resolusi Tinggi**:
   Jika kamera mendukung dual-stream, gunakan RTSP Sub-stream (misal 720p / 640x360) pada URL kamera untuk meminimalkan beban demuxing FFmpeg.
3. **Pemasangan Kipas USB Tambahan (Opsional tapi Direkomendasikan)**:
   Menempelkan kipas pendingin mini USB 5V (40mm atau 50mm) dengan tegangan 5V dari port USB STB dapat menurunkan suhu SoC hingga $15^\circ\text{C}\text{--}20^\circ\text{C}$ lebih dingin ($40\text{--}48^\circ\text{C}$ stabil).
